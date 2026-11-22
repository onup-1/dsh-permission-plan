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
| `index.mjs` | 插件实现：审批钩子 + 4 个工具 + 关键词引擎 |
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

加一个新区只要三步：在 `ZONES` 里加一项（`id` / `label` / `pattern` / 可选 `delegate`），决定是否委托给别的插件，再在 README 这张表补一行——`classify()`、词表过滤、`permission_check` 输出、`permission_keywords` 统计都会自动带上它。

## 分工：本插件管通用任务，mod 相关交给 dsh-mod-build-auto-approve

两个插件的**词表分开、职责分开**，不要合并：

| | dsh-mod-build-auto-approve | dsh-permission-plan（本插件） |
| --- | --- | --- |
| 领域 | Minecraft 模组构建：配环境、下 JDK、Gradle/Loom/Forge、编译产 mod、调 MC 启动与窗口位置 | 其余一切：读写文件、起进程、下载依赖、装包、改系统配置、跑测试 |
| 放行依据 | 领域正则 `fabric\|loom\|forge\|gradle\|daynight\|minecraft\|模组\|1.x.y` + 领域词表（forge/fabric/loom/gradle/maven/mcp/yarn/mixin…） | 无领域正则；靠权限簇识别 + 你批准过的通用关键词 |
| 词表文件 | `C:\Users\rog\Documents\deepseek-harness\default-workspace\dsh-mod-approve\learned.json` | `C:\Users\rog\Documents\deepseek-harness\default-workspace\plugins\dsh-permission-plan\learned.json` |
| 批量申请工具 | `mod_permission_plan`（模组场景专用文案） | `permission_plan`（通用） |

两者互不读写对方的 `learned.json`，删掉任一个都不影响另一个。

### 同时启用时的行为

- 同一个 `approval/request` 会先过两道钩子：谁先命中自己的词表谁就返回 `allowed-once`，另一个继续 `next()`，最后才轮到人工审批。
- **不会弹两次窗**：命中即返回，没命中的那个根本不会问人。
- **硬边界（代码保证）**：理由里出现 `fabric|loom|forge|gradle|minecraft|mixin|mcp|yarn|daynight|bmclapi|runserver|runclient|模组` 之一的请求，本插件**一律不自动放行**，交给 mod 插件判断；这些词也不会被本插件学进词表。
- **mod 插件不在时自动兜底**：如果 `dsh-mod-build-auto-approve` 被卸载或被 `plugin_manager` 禁用，上面的硬边界自动失效，模组域请求改由本插件按自己的关键词判断（否则你会退回逐条点批准）。检测方式是读 profile 的 `package.json`（`dsh.profile.bundles`）与 `cordis.patch.yml`（`- id: mod-build-auto-approve` 下的 `disabled` 标志），结果缓存 15 秒；`permission_check` 会打印「mod 插件检测：启用/未启用 · <profile 目录>」方便核对。
- 想强制关掉兜底（无论 mod 插件是否在，都不接管模组域）：设环境变量 `DSH_PERMISSION_PLAN_MOD_FALLBACK=0`。
- `配置` / `config` / `setup` / `设置` 是弱词：单条命中只提示、不自动放行，避免「一句配置」把模组环境配置顺手批了。

### 想把边界划得更死？

在模组构建的会话里，让模型先用 `mod_permission_plan` 批一次（模组词表命中），之后模组命令走旧插件；通用任务用 `permission_plan`。两套词表各记各的，长期会自然分岔。

## License

MIT，见 `LICENSE`。
