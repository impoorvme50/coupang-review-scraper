# Coupang 商品评论抓取工具 · 使用说明

一个脚本抓取 Coupang（韩国酷澎）任意商品的**全部可达评论**，输出 Excel 可直接打开的 CSV。

## 一、环境要求

| 项目 | 要求 |
|---|---|
| Node.js | **≥ 22**（`node -v` 查看；低于 22 请先升级） |
| 浏览器 | 装有 **Chrome** 即可（Edge / Brave / Dia 等 Chromium 内核也行；**Safari 不行**） |
| 网络 | 能正常打开 coupang.com（走公司代理的话，把**系统代理**开着就行，浏览器自动使用） |

无需 `npm install` 任何东西，单文件直接跑。

### Windows 用户

- **浏览器不用装**：Win10/11 自带的 Edge 就能跑，脚本自动识别；想用 Chrome 的话 `winget install Google.Chrome` 或官网下载。
- **只装 Node.js**：`winget install OpenJS.NodeJS.LTS`，或去 https://nodejs.org 下载 LTS 安装包，装完重开终端。
- 用法完全一样：`node coupang_reviews_tool.mjs <商品链接或ID>`。
- 代理：Clash/V2Ray 等开着**系统代理**模式即可，Edge/Chrome 会自动走。

### Mac 用户

- `brew install --cask google-chrome`（或直接用已装的 Chrome/Edge/Brave）。
- Node：`brew install node` 或官网安装包。

## 二、使用方法

```bash
# 方式1: 直接贴商品链接（从浏览器地址栏复制）
node coupang_reviews_tool.mjs "https://www.coupang.com/vp/products/8292063414?itemId=23914788072&vendorItemId=90963462547"

# 方式2: 只传商品ID（链接里 /vp/products/ 后面那串数字）
node coupang_reviews_tool.mjs 8292063414
```

运行后会自动弹出一个 Chrome 窗口（临时配置、不动你日常用的浏览器），自动打开商品页 → 过反爬验证 → 抓取评论。**第一次弹出的浏览器窗口请不要关闭**，脚本跑完会自己关。

### 常用选项

```bash
--out <目录>     输出目录，默认 ./coupang_output
--max-pages <N>  每个查询最多翻页数（默认 151 = 平台上限），调小可快速抽样
--browser <路径> 手动指定浏览器可执行文件
--keep-browser   跑完不关浏览器窗口（调试用）
```

例：只想先抽 200 条看看 → `node coupang_reviews_tool.mjs 8292063414 --max-pages 5`

## 三、输出文件

| 文件 | 说明 |
|---|---|
| `reviews.csv` | 评论明细，UTF-8 BOM 编码，**双击用 Excel 打开不乱码** |
| `summary.txt` | 汇总：评论总数、平均星级、各星级分布、抓取覆盖率、缺口说明 |
| `raw.json` | 接口原始数据备份（每页增量落盘，中途断掉也有数据） |

CSV 字段：评论ID、星级、日期（韩国时间）、昵称、买家类型、购买选项、评论类型（文字/图文/纯图片/纯打星）、评论内容、有用数、回复数、图片数、首图链接、有偿激励。

## 四、工作原理（30 秒版）

Coupang 用 Akamai 反爬，直接 HTTP 请求全被拦。脚本因此启动一个真实 Chrome（带远程调试端口），等商品页正常加载后，**在页面内部**调用 Coupang 自己的评论接口 `/next-api/review` 翻页抓取，再按星级过滤 + 双排序取并集、按评论ID去重，把单查询 150 页的平台限制影响降到最低。

## 五、常见问题

**Q: 提示「被 Coupang 临时限流」？**
A: 同一 IP 请求太频繁触发的，等 10~30 分钟、或切换代理出口节点后重跑即可。脚本已内置随机限速，正常一个商品一个商品抓不会触发。

**Q: 跑到一半断了，数据丢了吗？**
A: 没有。`raw.json` 每页都落盘。重跑一次即可（会重新抓全量，想要增量可自行基于 raw.json 处理）。

**Q: 能抓到全部评论吗？**
A: Coupang 每个查询最多返回 150 页 × 10 条。脚本自动按 1~5 星分别抓（低星级一般全量），只有当**单个星级超过 ~1500 条**时才会缺一截「无点赞的旧评论」——这部分在网页上人工翻页也翻不到，属于平台限制，summary.txt 会写明覆盖率。

**Q: 需要登录 Coupang 账号吗？**
A: 不需要，匿名即可看评论。

**Q: 浏览器窗口弹出来一直不动？**
A: 脚本正在等反爬验证通过（最多 150 秒，会自动刷新/换标签重试）。如果窗口里出现了需要点击的验证按钮，手动点一下即可，脚本会自动继续。

---
*如有 Coupang 页面改版导致接口失效，请提 Issue 或联系维护者。*
