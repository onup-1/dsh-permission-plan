# 更新记录

版本号跟随 `package.json`。日期为发布日期（本地时区 Asia/Shanghai）。
每个版本后面的 hash 是 GitHub 上 `onup-1/dsh-permission-plan` 对应的提交。

## 0.2.2 — 2026-11-23

这次是「冷启动别掉线」的健壮性修复，功能与 0.2.1 一致。

**修复**

- **重启后插件不生效**：DSH 桌面应用重启时，`webServer` / `tools` / `userQuestions` / `approval` 可能还没激活，`ctx.get(name)` 只返回「已经 active」的 provider，于是 `apply()` 里拿到 `undefined`，路由没注册、四个工具全消失（现象是 `permission_stats` 报 `unknown tool`、`/permission-plan/pending` 与 `/permission-plan/sounds` 一律 404，而同机别的插件路由正常）。
  - 新增 `serviceOf(ctx, name)`：先 `ctx.get(name)`，再退回属性读取 `ctx[name]`（属性读取走 Cordis 的 `inject` 声明，能拿到尚未 ready 的实例）。
  - `apply()` 里若 `webServer` 还没就绪，路由注册先入队，再 `ctx.inject(['webServer'], install)` 挂到子 fiber 上补装（`child.effect(() => server.register(options))`），不再静默丢路由。
  - 新增 `export const inject = ['tools']`：Cordis 会等工具注册表激活后才 apply 本插件，`ctx.get('tools')` 不会再是 `undefined`。`webServer` 仍保持可选（无头会话没有 web server）。

**变更**

- 浏览器 bundle 文件名保持 `client-0.2.1.js` 不变（只是产物名，内容未改）。

## 0.2.1 — 2026-11-22 · `d5de1d70`

这次是「界面与提示音」的一次收口。

**新增**

- **试听按钮**：输入框右下角出现一枚「试听」胶囊，位置贴着模型选择器左侧 8px、与模型名同一水平线（`modelAnchorRect()` 取圆形发送/停止键所在行，再向左找模型选择器节点定位）。点一下播当前提示音，鼠标悬停弹出小窗显示：当前提示音名、音频文件名、完整路径，并带「复制」按钮。
- **试听页** `GET /permission-plan/audio-lab.html`：把鲸鲸挂件 `assets` 目录下的全部音频（4 个 wav + `minecraft-exp-orb.wav` + 4 个 mp3）逐行列出，带 `<audio controls>`，用来在浏览器里挑音色。
- **音频路由** `GET /permission-plan/sound.wav[?name=]`：白名单发 `task-end-a.wav` / `approve-default.wav` / `ask-default.wav` / `cost-default.wav`；`GET /permission-plan/sounds` 返回当前音色与候选清单。
- **自检探针**（常设）：`GET /permission-plan/probe` 读最近一次前端上报，`POST /permission-plan/probe` 收上报，`GET /permission-plan/probe.html` 是绕过模块加载器直接加载 bundle 的独立探针页。上报内容含 `stage`（`boot-start` / `booted` / `boot-error: …`）、`viewport`、按钮矩形与 `display/visibility/opacity`、`modelRow`、`roundButton` 坐标。

**修复**

- 试听按钮「创建了但看不见」：`placeSoundButton()` 调用了一个不存在的函数（`findComposerRect`，真名 `composerRect()`），异常打断定位流程，按钮留在 `position:fixed` 默认位置——`top` 正好等于视口底边，等于跑到屏幕外。探针抓到的原文是 `boot-error: ReferenceError: findComposerRect is not defined`。
- 卡片不消失：轮询里「内容签名没变就早退」的分支把空列表也当成命中（`"" === ""`），`removeCard()` 永远走不到。改为先判空列表再返回。
- 启动时机：bundle 可能在本体 `<body>` 之前被 import，顶层 `document.body.appendChild` 会直接抛异常，之后既不轮询也不画卡。现在 `boot()` 会等 `DOMContentLoaded`，并整体包 try/catch 把异常上报到探针。

**变更**

- 提示音默认值 `synth` → `cost-default.wav`（鲸鲸挂件的费用提示音，用户盲听选定的那个）；合成音（880Hz → 1174.66Hz 两声）保留为兜底。
- 试听按钮去掉铃声图标，只留「试听」两个字；宽度、圆角、边框改了，避免挡住模型名。
- 浏览器 bundle 更名为 `client-0.2.1.js`（`package.json` 的 `exports["./client"]` 同步改），对外仍以 `/permission-plan/client.js` 路由提供。
- README 新增「提示音与试听」一节；文件表更新。

## 0.2.0 — 2026-11-22 · `c85442b0` → `42e153af`

**新增——自带审批卡（不接管输入框）**

DSH 原生审批卡是占用输入框那块位置显示的：卡片挂在 `composerSeat` 里，输入框被压成 `height: 0`，弹卡期间没法打字（实测输入框链路 `GRgSLq_input > grow > scroll > card > root` 全部 `height: 0`，三次采样都一样，CSS 撑开无效）。所以这一版把审批 UI 自己接管了：

- 宿主在 `approval/request` 钩子里不直接 `next()`，而是登记 `PENDING_APPROVALS`，等浏览器回答；
- 浏览器每秒轮询 `GET /permission-plan/pending`（兼作心跳），有待批就在输入框正上方画深色浮卡，宽度对齐输入区、水平居中、底边距输入区上沿 20px；
- 点「拒绝 / 允许一次」→ `POST /permission-plan/answer {id, allow}`；
- 卡片在时把输入框右下角圆形按钮设 `pointer-events:none`，避免点「允许一次」时误触停止；
- **回退**：浏览器 5 秒内没轮询就走原生卡；自带卡 5 分钟没人点也回退原生卡。不会出现「没人能批」的死锁。

**新增——提示音**

- 浮卡出现时响一声。0.2.0 用浏览器内合成音（WebAudio，880 → 1174.66Hz 两声，约 0.45 秒），只为解决「审批没有声音提醒」；0.2.1 起改用鲸鲸挂件的 wav。

**修复**

- 点「允许一次」后卡片不消失（见 0.2.1 同名条目，0.2.0 的 `42e153af` 是同一处修复的提交）。

**说明**

- 版本号从 0.1.0 提到 0.2.0：宿主多出两条 HTTP 路由与一个待批队列，浏览器多出整张卡片的渲染逻辑，属于功能级变化。

## 0.1.0 — 2026-11-22 · `96db1db8`

首个发布版本：把「批量预授权」从 `dsh-mod-build-auto-approve` 拆出来，做成领域无关的通用插件，并与「关键词识别一次通过」合并。

**新增**

- 四个工具：`permission_plan`（开工前一次性申请）、`permission_check`（只查不弹）、`permission_keywords`（list / forget / reset）、`permission_stats`（统计与决策时间线）。
- 七个权限类别：写工作区外文件、起停进程、网络下载、安装升级、系统配置、管理员、删除终止。
- 关键词记忆与学习：批准过的请求把命中的词记下来，同类下次自动放行；弱词单条命中仍需问人，两条以上才放行；文件搬运动词（`copy/move/write/rename` 及中文对应）永远只是弱词，且被批准后**不会**被提升为强词。
- 安全闸：`DANGER_PATTERN` 命中即不自动放行、也不学习；`plugin_manager` 不在自动放行工具集内。
- 分区（zones）：`mod` / `github` / `other` 三个区，各带自己的词表；`mod` 区可委托给 `dsh-mod-build-auto-approve`，对方不在时自动兜底接管；`other` 区的词对所有区生效。
- 与 `dsh-mod-build-auto-approve` 的 mod 词表同步（只读对方 `learned.json`，15 秒节流 + mtime 比对）。

**已知限制（当时）**

- 只改了构建产物，没有上游 `src`；`index.mjs` 的 region 注释仍指向 `src/index.ts` / `src/shared.ts`。
- 词表是纯文本匹配，没有语义理解：写法变化大的请求仍会走人工。
