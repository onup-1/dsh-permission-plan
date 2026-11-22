# dsh-permission-plan

开工前一次性把这活要用的权限问完，之后靠记住的关键词放行——不再一条命令弹一次窗。

> 从 `dsh-mod-build-auto-approve` 里把「批量预授权」这一半拆出来，做成与 Minecraft/模组无关的通用插件，并和「关键词识别一次通过」合并成一个插件。

## 它解决什么

DSH 的沙箱在写工作区之外、起进程、下载依赖、改系统文件时会弹审批。一次任务可能要弹十几次，每次都得点。

这个插件把审批拆成两段：

1. **开工前一次问完。** 模型在动手前调用 `permission_plan`，把这次要做的操作一次列出来。插件按「权限类别」归并，弹**一个**审批框。批准后，这一批操作的关键词被记下来。
2. **之后按关键词放行。** 后续提权请求如果命中已记住的关键词，直接放行，不再弹窗；没命中的照常问人。

人工批准过的请求也会被学习：你点过一次「批准」，同类请求下次就不问了。

## 三个工具

| 工具 | 作用 |
| --- | --- |
| `permission_plan` | 开工前调用一次。传 `items`（每个操作一行）+ 可选 `task`/`note`/`scope`。弹**一个**合并审批框；批准即记住关键词。 |
| `permission_check` | 只查不弹窗。给出「这条命令会碰到哪些权限类别、哪些关键词已覆盖、是否必须问人」。 |
| `permission_keywords` | `list` 看已记住哪些词（含命中次数、来源、日期）；`forget` 忘掉一个；`reset` 全清。 |
| `permission_stats` | 统计：自动放行多少次、人工多少次、拒绝多少次、批量授权多少次，以及是哪些关键词在干活。 |

## 权限类别（自动归类）
## 两种弹窗

- **单个权限**（一个操作项、一个类别）：不弹批量卡，直接走「自带审批卡」（见下一节），只对这次生效，**不记关键词**。如果浏览器半边没在跑，才回退到宿主的 `approval.request()`。
- **多个权限**（跨类别或多个操作项）：弹本插件的一次性权限卡，批准后按类别记住关键词，之后同类自动放行。

判断依据是 `items.length <= 1 && clusters.length === 1`。宿主若没有 `approval` 服务（或不在回合内），批量卡也会自动回退，不会静默放行。

## 自带审批卡（不接管输入框）

DSH 原生审批卡是**占用输入框那块地方**显示的：卡片挂在 `composerSeat` 里，输入框被压成 `height: 0`，所以弹卡的那几秒你没法打字。本插件改成了自己画卡：

- 宿主侧在 `approval/request` 钩子里不再直接 `next()`，而是登记一条待批（`PENDING_APPROVALS`），等浏览器回答；
- 浏览器侧每秒轮询 `GET /permission-plan/pending`（同时兼作心跳），有待批就在**输入框正上方**画一张深色浮卡：宽度对齐输入区、水平居中、底边距输入区上沿 20px，按钮是「拒绝 / 允许一次」；
- 点按钮 → `POST /permission-plan/answer {id, allow}` → 钩子拿到 `allowed-once` / `rejected` 继续往下走；
- 卡片在时，输入框右下角那个圆形按钮会被设成不可点（`pointer-events:none`），避免点「允许一次」时误触「停止生成」；
- **回退**：浏览器 5 秒内没轮询（页面没开、插件客户端没加载）就不走自带卡，仍用 DSH 原生卡；自带卡 5 分钟没人点也回退原生卡。所以不会出现「没人能批」的死锁。



`permission_plan` / `permission_check` 会按任务文字识别出这些类别，并原样展示给用户：

| 类别 | 触发词示例 |
| --- | --- |
| 写入工作区之外的文件 | write / save / copy / move / 写入 / 保存 / 复制 / 覆盖 |
| 启动或结束本地进程 | start / spawn / java / gradle / npm / 编译 / 运行 |
| 访问网络、下载依赖 | download / curl / http / git clone / 下载 / 拉取 / 镜像 |
| 安装、升级软件包 | install / upgrade / unzip / 安装 / 升级 / 解压 |
| 修改系统级配置 | hosts / registry / service / schtasks / 注册表 / 计划任务 / 防火墙 |
| 请求管理员权限 | admin / uac / sudo / elevat / 管理员 / 提权 |
| 删除或终止 | delete / rm / kill / Remove-Item / 删除 / 清空 |

## 安全边界（重要）

- **删除/终止类永远单独问。** 只要请求文字里出现 `rm`、`del`、`Remove-Item`、`taskkill`、`删除`、`清空` 等，`permission_plan` 会明确标注「仍需单独批准」，审批钩子也永不放行这一类。
- **`plugin_manager` 永不放行。** 装/卸插件必须你亲手点。
- **只对已知工具生效。** 自动放行只覆盖 `pwsh`/`bash`/`write`/`edit`/`read`/`glob`/`grep`；别的工具照常问人。
- **弱词要两条才算。** `mod`、`java`、`build`、`cache`、`下载`、`构建` 这类到处都有的词，单条命中不构成放行理由（除非你亲手批准过它一次，之后它被「提升」为强词）。
- 判断依据是**请求里的文字说明**，由发起请求的模型填写。所以这是便利层，不是安全边界：第一次遇到某一类永远会问你。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件实现：审批钩子 + 4 个工具 + 关键词引擎 + 待批队列与两条 HTTP 路由 |
| `client.js` | 浏览器半边：轮询待批、画浮卡、回传回答（纯 DOM，无 React） |
| `learned.json` | 运行时生成的记忆（关键词表、批量授权记录、计数）。删掉等于全忘 |
| `stats.jsonl` | 逐条决策日志（自动/人工/拒绝/批量），超过 10 万条自动裁头 |
| `cordis.patch.yml` | bundle 注入声明 |

## 安装

```
plugin_manager install_bundle  target=<本目录绝对路径>
```

改完热重载：

```
plugin_manager set_plugin  target=include:permission-plan  enabled=false
plugin_manager set_plugin  target=include:permission-plan  enabled=true
```

卸载：

```
plugin_manager remove_bundle  target=dsh-permission-plan
```

## 典型流程

```
模型：permission_plan({
        task: "给这个 Fabric 模组搭构建环境",
        items: [
          "写 D:\\Gradle 缓存目录",
          "启动 Gradle/Java 进程",
          "从镜像站下载依赖"
        ]
      })
用户：（看到一个框）→ 全部批准
模型：（继续干活，同类命令不再弹窗）
```

想看省了多少次点击：`permission_stats({ limit: 20 })`。

## 分区（zones）

这个插件是**权限总框架**：每个审批请求先被分到一个「区」，每个区的规则和词表各自独立，互不串味。

| 区 | 识别依据 | 归属 |
| --- | --- | --- |
| `mod` Minecraft 模组 | `fabric` / `loom` / `forge` / `gradle` / `minecraft` / `mixin` / `yarn` / `daynight` / `runserver` / `模组` 等 | 装了 `dsh-mod-build-auto-approve` 就委托给它；没装则由本插件接管 |
| `github` GitHub / 版本库 | `github` / `gist` / `git` / `git-ssl` / `commit` / `push` / `pull request` / `clone` / `branch` / `repo` / `api.github` 等 | 本插件自己管 |
| `other` 其他 | 兜底 | 本插件自己管 |

规则：

- 词表按区分开存：`learned.json` 里每条是 `{ word, zone, at, uses, source }`。一个区记住的词，不会让另一个区自动放行。
- `other` 区的词在三个区里都算命中（`pwsh` 这类通用词本来就跨区有效）；反过来 `mod` 区的词不会在 `github` 区生效。
- 计划跨区也安全：`permission_plan` 会**逐条**判断每个操作项属于哪个区，分别记进各自词表（例如「构建模组 + push 到 GitHub」会同时写进 `mod` 和 `github`）。
- 删除/终止类操作在任何区都不会自动放行；`plugin_manager` 同样永不自动放行。
- 关掉 mod 兜底：设 `DSH_PERMISSION_PLAN_MOD_FALLBACK=0`。
- **mod 区词表单向同步**：每次判断前（15 秒节流 + 文件 mtime 检查）读一次 `profiles/<profile>/node_modules/dsh-mod-build-auto-approve/learned.json`，把 `dsh-mod-build-auto-approve` 新学到的词复制进 `mod` 区（来源标记 `mod-plugin`），它的 `promoted` 弱词也一起带过来。所以那两个插件各管各的词表，但 mod 区的词不会落后。换路径用 `DSH_PERMISSION_PLAN_MOD_STORE`。
- 同一个词如果已经记在 `other` 区，就不再重复导入 `mod` 区（`other` 的词本来就对所有区生效），避免一条词在两个区各存一份。
- 历史遗留：分区出现之前学到的模组味词（`构件`、`userdev`、`jar`、`复验构建` 等）会被自动迁移进 `mod` 区，**不删除**，只是换到它该在的区。

加一个新区只要三步：在 `ZONES` 里加一项（`id` / `label` / `pattern` / 可选 `delegate`），决定是否委托给别的插件，再在 README 这张表补一行——`classify()`、词表过滤、`permission_check` 输出、`permission_keywords` 统计都会自动带上它。

## 分工：本插件管通用任务，mod 相关交给 dsh-mod-build-auto-approve

两个插件的**词表分开、职责分开**，不要合并：

| | dsh-mod-build-auto-approve | dsh-permission-plan（本插件） |
| --- | --- | --- |
| 领域 | Minecraft 模组构建：配环境、下 JDK、Gradle/Loom/Forge、编译产 mod、调 MC 启动与窗口位置 | 其余一切：读写文件、起进程、下载依赖、装包、改系统配置、跑测试 |
| 放行依据 | 领域正则 `fabric\|loom\|forge\|gradle\|daynight\|minecraft\|模组\|1.x.y` + 领域词表（forge/fabric/loom/gradle/maven/mcp/yarn/mixin…） | 无领域正则；靠权限簇识别 + 你批准过的通用关键词 |
| 词表文件 | `C:\Users\rog\Documents\deepseek-harness\default-workspace\dsh-mod-approve\learned.json` | `C:\Users\rog\Documents\deepseek-harness\default-workspace\plugins\dsh-permission-plan\learned.json` |
| 批量申请工具 | `mod_permission_plan`（模组场景专用文案） | `permission_plan`（通用） |

`dsh-mod-build-auto-approve` 的定位是「只想让模组相关一路畅通」的人：它只管模组那摊事，别的权限一概不自动放行。本插件是总框架，模组那摊事在 `mod` 区里，装了旧插件就委托给它、没装就自己接管。

### 同时启用时的行为

- 同一个 `approval/request` 会先过两道钩子：谁先命中自己的词表谁就返回 `allowed-once`，另一个继续 `next()`，最后才轮到人工审批。
- **不会弹两次窗**：命中即返回，没命中的那个根本不会问人。
- **硬边界（代码保证）**：分区判定为 `mod` 的请求，本插件**一律不自动放行**，交给 mod 插件判断；这种判定在 `remember()` 里也拦着，通用区学不到模组词。
- **mod 区词表跟得上**：旧插件的 `learned.json` 会被单向读进来（见上面「分区」一节的同步规则），所以你在旧插件那边新批下来的模组词，这边 `mod` 区立刻就有——不需要手工抄。
- **mod 插件不在时自动兜底**：如果 `dsh-mod-build-auto-approve` 被卸载或被 `plugin_manager` 禁用，委托自动失效，模组域请求改由本插件按 `mod` 区词表判断（否则你会退回逐条点批准）。检测方式是读 profile 的 `package.json`（`dsh.profile.bundles`）与 `cordis.patch.yml`（`- id: mod-build-auto-approve` 下的 `disabled` 标志），结果缓存 15 秒；`permission_check` 会打印「mod 插件检测：启用/未启用 · <profile 目录>」方便核对。
- 想强制关掉兜底（无论 mod 插件是否在，都不接管模组域）：设环境变量 `DSH_PERMISSION_PLAN_MOD_FALLBACK=0`。
- `配置` / `config` / `setup` / `设置` 是弱词：单条命中只提示、不自动放行，避免「一句配置」把模组环境配置顺手批了。
- 文件搬运动词 `复制`/`copy`/`移动`/`move`/`写入`/`write`/`重命名`/`rename` 也是弱词，而且**永远不会被提升**（批准过一次计划也不提升）：这类词只说明动作、不说明落在哪，必须两条命中或配合一个强词才放行。

### 为什么要分成两套词表

旧插件不要动：它的用户只想要模组放行，多给别的权限等于替他们做主。本插件也不该把模组词塞进 `other` 区——`other` 区的词对所有区生效，一个 `jar` 放在那儿就等于给 GitHub 区也开了口子。所以：模组词归 `mod` 区（并可单向继承旧插件的词表），通用词归 `other` 区，GitHub 词归 `github` 区。

## License

MIT，见 `LICENSE`。
