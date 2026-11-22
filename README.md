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

## 和 dsh-mod-build-auto-approve 的关系

那个插件管 Minecraft 模组构建场景（内置 fabric/gradle 正则 + 提示音 + 模组关键词表），功能上包含本插件的两部分。本插件是**通用版**：不绑定任何领域，类别靠规则识别，关键词表独立。

两者可以同时装：同一个请求会被两套词表各自判断，谁命中谁放行，结论一致；两边的 `learned.json` / `stats.jsonl` 完全独立，互不读写。若只想留一套词表，禁用一个即可。

注意：两边都会对同一个审批请求做判断，**不会**因此多弹一次窗——先命中的那个直接返回放行，没命中的继续往下走。

## License

MIT，见 `LICENSE`。
