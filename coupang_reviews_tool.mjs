#!/usr/bin/env node
/**
 * Coupang 商品评论抓取工具（开箱即用版）
 * ============================================================
 * 用法:
 *   node coupang_reviews_tool.mjs <商品URL 或 商品ID> [选项]
 *
 * 示例:
 *   node coupang_reviews_tool.mjs "https://www.coupang.com/vp/products/8292063414?itemId=23914788072&vendorItemId=90963462547"
 *   node coupang_reviews_tool.mjs 8292063414
 *   node coupang_reviews_tool.mjs 8292063414 --out ./我的输出 --max-pages 151
 *
 * 选项:
 *   --out <目录>      输出目录（默认 ./coupang_output）
 *   --port <端口>     CDP 调试端口（默认自动挑空闲端口）
 *   --max-pages <N>   每个查询最多翻多少页（默认 151，即接口上限 150 页）
 *   --browser <路径>  指定浏览器可执行文件（默认自动找 Chrome/Dia/Edge/Brave）
 *   --keep-browser    结束后不关闭浏览器窗口（调试用）
 *
 * 环境要求:
 *   1. Node.js >= 22（自带 fetch / WebSocket，无需 npm install 任何东西）
 *   2. 本机装有 Chrome（推荐；没有的话 Edge / Brave / Dia 等 Chromium 内核浏览器也可以，Safari 不行）
 *   3. 网络能访问 coupang.com（需要代理的话系统代理开着即可，浏览器会自动走）
 *
 * 输出（写入 --out 目录）:
 *   reviews.csv       评论明细（UTF-8 BOM，Excel 双击直接打开）
 *   summary.txt       抓取汇总（总数/覆盖率/评分分布/缺口说明）
 *   raw.json          接口原始数据（每页一包，增量落盘，中断也有数据）
 *
 * 已知平台限制（非脚本问题）:
 *   Coupang 每个查询最多返回 150 页 × 10 条。脚本会自动按星级过滤 + 双排序取并集，
 *   单一星级超过 ~1500 条时，多出的无点赞旧评论网页端本身就翻不到。
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

/* ---------------- 参数解析 ---------------- */
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith("--") || args[0] === "-h" || args[0] === "--help") {
  console.log("用法: node coupang_reviews_tool.mjs <商品URL 或 商品ID> [--out 目录] [--port 端口] [--max-pages N] [--browser 浏览器路径] [--keep-browser]");
  process.exit(args.length === 0 ? 1 : 0);
}
const TARGET_RAW = args[0];
const opt = { out: "./coupang_output", port: 0, maxPages: 151, browser: "", keepBrowser: false };
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--out") opt.out = args[++i];
  else if (args[i] === "--port") opt.port = +args[++i];
  else if (args[i] === "--max-pages") opt.maxPages = +args[++i];
  else if (args[i] === "--browser") opt.browser = args[++i];
  else if (args[i] === "--keep-browser") opt.keepBrowser = true;
}

// 从 URL 或纯数字里提取商品 ID
const m = TARGET_RAW.match(/\/vp\/products\/(\d+)/) || TARGET_RAW.match(/^(\d{6,})$/);
if (!m) {
  console.error(`✗ 无法从 "${TARGET_RAW}" 中识别商品ID。请传入 coupang.com/vp/products/<数字> 形式的链接，或直接传商品ID。`);
  process.exit(1);
}
const PRODUCT_ID = m[1];
const PRODUCT_URL = `https://www.coupang.com/vp/products/${PRODUCT_ID}`;

if (typeof WebSocket === "undefined") {
  console.error(`✗ 需要 Node.js >= 22（自带 WebSocket）。当前版本 ${process.version}，请先升级 Node。`);
  process.exit(1);
}

const OUT_DIR = resolve(opt.out);
mkdirSync(OUT_DIR, { recursive: true });
const log = (s) => console.error(`[${new Date().toTimeString().slice(0, 8)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 找浏览器（优先 Chrome，其他 Chromium 内核也行） ---------------- */
function findBrowser() {
  if (opt.browser) return opt.browser;
  const home = process.env.HOME || "";
  const candidates = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Dia.app/Contents/MacOS/Dia",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ] : process.platform === "win32" ? [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ] : [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
    "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  if (home && process.platform === "win32") {
    const local = join(home, "AppData", "Local");
    for (const c of [
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ])
      if (existsSync(c)) return c;
  }
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) {
  console.error("✗ 未找到 Chromium 内核浏览器（Chrome/Dia/Edge/Brave）。请用 --browser 指定浏览器可执行文件路径。");
  process.exit(1);
}
log(`浏览器: ${BROWSER}`);

/* ---------------- 2. 挑端口 + 启动（或复用）浏览器 ---------------- */
import net from "node:net";
async function portFree(p) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(p, "127.0.0.1");
  });
}
async function cdpAlive(p) {
  try { const j = await fetch(`http://127.0.0.1:${p}/json/version`).then((r) => r.json()); return !!j.Browser; } catch { return false; }
}

let PORT = opt.port || 9300;
if (!(await cdpAlive(PORT))) {
  // 端口上没有可复用的浏览器才挑新端口并自己启动
  while (!(await portFree(PORT))) PORT++;
}
const CDP = `http://127.0.0.1:${PORT}`;

let child = null;                 // 只有自己启动的浏览器才会在结束时关闭
let browserErrTail = "";
const cleanup = () => { if (child) { try { child.kill(); } catch {} } };
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

if (await cdpAlive(PORT)) {
  log(`端口 ${PORT} 上已有带调试接口的浏览器，直接复用（结束后不会关它）`);
} else {
  const profileDir = join(tmpdir(), `coupang-cdp-${Date.now()}`);
  log(`启动浏览器（调试端口 ${PORT}，临时配置 ${profileDir}）...`);
  child = spawn(BROWSER, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check",
    PRODUCT_URL,
  ], { detached: false, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (d) => { browserErrTail = (browserErrTail + d.toString()).slice(-1500); });
  child.on("error", (e) => { console.error("✗ 浏览器启动失败:", e.message); process.exit(1); });
  child.on("exit", (code, sig) => { if (code !== null && code !== 0) log(`浏览器进程退出 (code=${code} sig=${sig})`); });

  // 等自己启动的浏览器 CDP 就绪（启动早期 socket 可能闪断）
  let cdpUp = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpAlive(PORT)) { cdpUp = true; break; }
  }
  if (!cdpUp) {
    console.error("✗ 浏览器调试端口未就绪（30秒超时）。浏览器输出尾部:\n" + browserErrTail);
    cleanup(); process.exit(1);
  }
}
log("CDP 就绪");

/* ---------------- 3. CDP 封装（带超时+重试，容忍 Akamai 自重载） ---------------- */
let msgId = 0;
const pending = new Map();
let ws = null;
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const w = new WebSocket(wsUrl);
    w.onopen = () => res(w);
    w.onerror = () => rej(new Error("ws 连接失败"));
    w.onclose = () => { for (const { rej: rj } of pending.values()) rj(new Error("ws closed")); pending.clear(); };
    w.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res: rs, rej: rj, timer } = pending.get(m.id);
        clearTimeout(timer); pending.delete(m.id);
        m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result);
      }
    };
  });
}
function send(method, params = {}, timeoutMs = 20000) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, { res: res, rej, timer });
  });
}
async function evalJs(expr, timeoutMs = 25000, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    } catch (e) {
      const transient = /timeout|Cannot find context|context was destroyed|ws closed|-32000|InjectedScript/.test(e.message || "");
      if (i === retries - 1 || !transient) throw e;
      await sleep(1500);
    }
  }
}

// 找到/创建商品页标签（浏览器启动早期 target 可能还没出现，轮询兜底）
async function getTab() {
  for (let i = 0; i < 30; i++) {
    let list = [];
    try { list = await fetch(`${CDP}/json/list`).then((r) => r.json()); } catch { continue; }
    if (!Array.isArray(list)) continue;
    const page = list.find((t) => t.type === "page" && t.url.includes(`/vp/products/${PRODUCT_ID}`))
      || list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
    if (page) {
      try {
        ws = await connect(page.webSocketDebuggerUrl);
      } catch { continue; }
      await send("Runtime.enable").catch(() => {});
      await send("Page.enable").catch(() => {});
      if (!page.url.includes(`/vp/products/${PRODUCT_ID}`)) {
        await send("Page.navigate", { url: PRODUCT_URL }).catch(() => {});
      }
      return;
    }
    await sleep(1000);
  }
  // 没有可用标签则新建
  let t = null;
  try { t = await fetch(`${CDP}/json/new`, { method: "PUT" }).then((r) => r.json()); } catch (e) {
    console.error("✗ 无法新建标签页（浏览器可能已退出）。浏览器输出尾部:\n" + browserErrTail);
    if (!opt.keepBrowser) cleanup();
    process.exit(1);
  }
  ws = await connect(t.webSocketDebuggerUrl);
  await send("Runtime.enable").catch(() => {});
  await send("Page.enable").catch(() => {});
  await send("Page.navigate", { url: PRODUCT_URL }).catch(() => {});
}
await getTab();

/* ---------------- 4. 等页面过 Akamai（带自愈 + 403限流识别） ---------------- */
let deniedHinted = false;
let ready = false;
let lastProgress = "";
let soft403Count = 0;
for (let i = 0; i < 100; i++) {
  await sleep(1500);
  let st = null;
  try {
    st = await evalJs(`({t: document.title, len: document.body ? document.body.innerHTML.length : 0, e403: !!document.getElementById('error403') || /사용권한이 없습니다/.test(document.body ? document.body.innerText : '')})`, 5000, 1);
  } catch {}
  if (st) {
    const progress = (st.t || "") + st.len;
    if (progress !== lastProgress) { log(`页面状态: "${(st.t || "").slice(0, 44)}" len=${st.len}`); lastProgress = progress; }
    if (/쿠팡|Coupang/i.test(st.t || "") && st.len > 50000 && !st.e403) { ready = true; break; }
    // Coupang 软403页（IP 被临时限流）：等待冷却后自动重试，两次仍失败则明确报错退出
    if (st.e403) {
      soft403Count++;
      log(`⏳ 被 Coupang 临时限流（请求过于频繁）。等待 60 秒后重试（第 ${soft403Count}/2 次）...`);
      if (soft403Count >= 2) {
        console.error("✗ 该 IP 被 Coupang/Akamai 临时限制访问。解决办法:");
        console.error("  1. 等 10~30 分钟再跑；");
        console.error("  2. 或切换代理/VPN 出口节点后立即重跑；");
        console.error("  3. 降低使用频率（脚本已内置限速，避免同一 IP 连续抓多个商品）。");
        if (!opt.keepBrowser) cleanup();
        process.exit(1);
      }
      await sleep(60000);
      await send("Page.navigate", { url: PRODUCT_URL }).catch(() => {});
      i = -1;
      continue;
    }
    if (/Access Denied/i.test(st.t || "") && !deniedHinted) {
      deniedHinted = true;
      console.log("⚠ 被反爬验证拦住了。请在刚打开的浏览器窗口里手动点一下验证/等它自动跳转（脚本会继续等待）。");
    }
    if (i === 20) { log("页面长时间无进展，刷新重试..."); await send("Page.reload").catch(() => {}); }
    if (i === 40) {
      log("刷新无效，新建标签页重试...");
      try {
        const t = await fetch(`${CDP}/json/new`, { method: "PUT" }).then((r) => r.json());
        try { ws.close(); } catch {}
        ws = await connect(t.webSocketDebuggerUrl);
        await send("Runtime.enable").catch(() => {});
        await send("Page.enable").catch(() => {});
        await send("Page.navigate", { url: PRODUCT_URL }).catch(() => {});
      } catch {}
    }
  }
}
if (!ready) {
  console.error("✗ 150 秒内页面未就绪。可能原因: 网络/代理无法访问 coupang.com，或反爬验证未通过。");
  console.error("  可加 --keep-browser 参数保留浏览器窗口，手动确认页面能打开后再重跑。原始数据（若有）见 raw.json");
  if (!opt.keepBrowser) cleanup();
  process.exit(1);
}
log("商品页就绪");

/* ---------------- 5. 探测评论接口 ---------------- */
const REVIEW_API = (page, sortBy, ratings) =>
  `/next-api/review?productId=${PRODUCT_ID}&page=${page}&size=10&sortBy=${sortBy}&ratingSummary=true&ratings=${ratings}&market=`;
const fetchPageJs = (p, sortBy, ratings) =>
  `(async () => {
    const r = await fetch(${JSON.stringify(REVIEW_API(p, sortBy, ratings))}, {credentials:'include', headers:{Accept:'application/json'}});
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch(e) { return {status: r.status, parseError: true, head: text.slice(0,150)}; }
    return {status: r.status, data: j};
  })()`;

let probe;
try { probe = await evalJs(fetchPageJs(1, "ORDER_SCORE_ASC", ""), 30000, 2); }
catch (e) { console.error("✗ 评论接口探测失败:", e.message); if (!opt.keepBrowser) cleanup(); process.exit(1); }
if (!probe || probe.parseError || probe.status !== 200 || !probe.data?.rData) {
  console.error("✗ 评论接口异常返回:", JSON.stringify(probe).slice(0, 300));
  console.error("  该商品可能无评论或使用了不同的评论系统。");
  if (!opt.keepBrowser) cleanup();
  process.exit(1);
}
const rd0 = probe.data.rData;
const summary = rd0.ratingSummaryTotal || {};
const totalCount = summary.ratingCount ?? rd0.reviewTotalCount ?? 0;
const dist = Object.fromEntries((summary.ratingSummaries || []).map((s) => [s.rating, s.count]));
log(`评论总数: ${totalCount}，平均 ${summary.ratingAverage ?? "?"} 星，分布: ${JSON.stringify(dist)}`);
if (totalCount === 0) {
  writeFileSync(join(OUT_DIR, "summary.txt"), `商品 ${PRODUCT_ID} 没有评论。\n`);
  console.log("该商品没有评论，已写 summary.txt。");
  if (!opt.keepBrowser) cleanup();
  process.exit(0);
}

/* ---------------- 6. 抓取计划：按星级过滤 + 必要时双排序 ---------------- */
const rawPages = [ { ratings: "", sortBy: "ORDER_SCORE_ASC", page: 1, data: probe.data } ];
const byId = new Map();
const absorb = (data) => {
  for (const c of data?.rData?.paging?.contents || []) {
    const prev = byId.get(c.reviewId);
    if (!prev || ((!prev.content || !prev.content.trim()) && c.content && c.content.trim())) byId.set(c.reviewId, c);
  }
};
absorb(probe.data);
writeFileSync(join(OUT_DIR, "raw.json"), JSON.stringify(rawPages));

async function runQuery(ratings, sortBy, maxPages) {
  for (let p = 1; p <= maxPages; p++) {
    if (ratings === "" && sortBy === "ORDER_SCORE_ASC" && p === 1) { /* 已有第1页 */ }
    let res;
    try { res = await evalJs(fetchPageJs(p, sortBy, ratings)); }
    catch {
      await sleep(4000);
      try { res = await evalJs(fetchPageJs(p, sortBy, ratings)); }
      catch (e) { log(`✗ ${ratings || "全部"}★ ${sortBy} 第${p}页两次失败: ${e.message.slice(0, 60)}`); return false; }
    }
    if (!res || res.parseError || res.status !== 200) { log(`✗ ${ratings || "全部"}★ ${sortBy} 第${p}页异常: ${JSON.stringify(res).slice(0, 80)}`); return false; }
    const items = res.data?.rData?.paging?.contents || [];
    rawPages.push({ ratings, sortBy, page: p, data: res.data });
    absorb(res.data);
    writeFileSync(join(OUT_DIR, "raw.json"), JSON.stringify(rawPages));
    process.stdout.write(`\r已抓 ${byId.size} 条（${ratings || "全部"}★ ${sortBy} 第${p}页，本页${items.length}条）   `);
    if (items.length === 0) return true;
    await sleep(600 + Math.floor(Math.random() * 700));
  }
  return true;
}

const CAP = opt.maxPages;
for (const rating of [5, 4, 3, 2, 1]) {
  const count = dist[rating] || 0;
  if (!count) continue;
  const pages = Math.min(CAP, Math.ceil(count / 10) + 1);
  await runQuery(String(rating), "ORDER_SCORE_ASC", pages);
  // 该星级没抓全（超出单查询页数上限或测试限页）→ 用"最新排序"再开一个窗口取并集
  const got = [...byId.values()].reduce((n, c) => n + (+c.rating === rating ? 1 : 0), 0);
  if (got < count) {
    log(`${rating}★ 已抓 ${got}/${count}，追加最新排序补齐...`);
    await runQuery(String(rating), "ORDER_RECENT_DESC", CAP);
  }
}
console.log();
log(`抓取完成：共 ${byId.size} / ${totalCount} 条（覆盖率 ${(byId.size * 100 / totalCount).toFixed(1)}%）`);

/* ---------------- 7. 生成 CSV + summary ---------------- */
const KST = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const esc = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const rows = [...byId.values()].map((c) => {
  const dt = c.reviewAt ? KST.format(new Date(+c.reviewAt)) : "";
  const atts = c.attachments || [];
  const hasMedia = atts.length > 0 || (c.videoAttachments || []).length > 0;
  const text = (c.content || "").replace(/\n{3,}/g, "\n\n").trim();
  const rtype = text ? (hasMedia ? "图文" : "文字") : hasMedia ? "纯图片" : "纯打星";
  return [c.reviewId, c.rating, dt, c.displayName || "", c.displayWriter || "",
    (c.itemName || "").split(", ").slice(1).join(", "), rtype, text,
    c.helpfulCount ?? 0, c.commentCount ?? 0, atts.length,
    atts[0]?.url || "", c.incentive ? "是" : "否"];
});
rows.sort((a, b) => String(b[2]).localeCompare(String(a[2])));

const CSV_PATH = join(OUT_DIR, "reviews.csv");
const BOM = "\uFEFF";
writeFileSync(CSV_PATH,
  BOM + ["评论ID", "星级", "日期", "昵称", "买家类型", "购买选项", "评论类型", "评论内容", "有用数", "回复数", "图片数", "首图链接", "有偿激励"]
    .map(esc).join(",") + "\r\n" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n");

const gotDist = {};
for (const c of byId.values()) gotDist[c.rating] = (gotDist[c.rating] || 0) + 1;
const distLines = [5, 4, 3, 2, 1].map((r) =>
  `  ${r}星: 平台 ${dist[r] ?? 0} 条 / 抓到 ${gotDist[r] ?? 0} 条`).join("\n");
const missNote = byId.size < totalCount
  ? `\n缺口说明: 单一星级评论超过1500条时，Coupang接口150页上限之外的无点赞旧评论网页端无法翻到（人为翻页同样看不到），非脚本缺陷。\n`
  : "\n全部评论已抓取。\n";
writeFileSync(join(OUT_DIR, "summary.txt"),
`Coupang 评论抓取汇总
商品ID: ${PRODUCT_ID}
商品链接: ${PRODUCT_URL}
评论总数: ${totalCount}，平均星级: ${summary.ratingAverage ?? "?"}
实际抓到: ${byId.size} 条（覆盖率 ${(byId.size * 100 / totalCount).toFixed(1)}%）
评分分布:
${distLines}
${missNote}抓取时间: ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" })} (韩国时间)
字段说明见表头；评论类型: 文字/图文/纯图片/纯打星。日期为韩国时间。
`);

console.log(`
✓ 完成！
  CSV   : ${CSV_PATH}
  汇总  : ${join(OUT_DIR, "summary.txt")}
  原始  : ${join(OUT_DIR, "raw.json")}
  共 ${byId.size} / ${totalCount} 条（${(byId.size * 100 / totalCount).toFixed(1)}%）`);

if (!opt.keepBrowser) cleanup();
process.exit(0);
