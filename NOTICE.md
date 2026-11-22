# NOTICE

`dsh-permission-plan` 是从 **`dsh-mod-build-auto-approve`** 里拆出来的通用版——上游是本机安装的 `dsh-mod-build-auto-approve@5.1.0`（同一作者写的另一个插件，私有，源码在 `C:\Users\rog\Documents\deepseek-harness\default-workspace\dsh-mod-approve\`，未公开发布）。

## 拆了什么

`dsh-mod-build-auto-approve` 做了两件绑定在一起的事：

1. 监听审批事件，理由里出现 `fabric|loom|forge|gradle|daynight|minecraft|模组` 就放行（模组专用正则）；
2. 提供 `mod_permission_plan` 工具，开工前把一批权限合成**一个**审批框，并把关键词永久记住。

本插件把第 2 件抽出来做成**不绑定任何领域**的通用版，并和第 1 件合并成一套统一的「批量申请 + 关键词放行」：

| 方面 | dsh-mod-build-auto-approve | dsh-permission-plan |
| --- | --- | --- |
| 适用场景 | 只有 Minecraft 模组构建 | 任意任务（写文件、起进程、下载、装包、改系统配置） |
| 内置放行依据 | 固定正则（fabric/gradle/模组…） | 无领域正则，全部靠权限簇识别 + 用户批准后学到的关键词 |
| 工具 | `mod_permission_plan`、`mod_permission_stats` | `permission_plan`、`permission_check`、`permission_keywords`、`permission_stats` |
| 词表 | `learned.json`（模组域词优先） | 独立 `learned.json`（通用词，带弱词提升） |
| 提示音 | 弹审判前播 wav | 不播 |

两者共用同一套设计取舍（删除类永不放行、`plugin_manager` 不自动放行、弱词需两条命中、批准后才学习），因此可以同时安装：同一个请求会被两套词表各自判断，谁命中谁放行，结论一致。

## 职责边界

本插件**不接管** Minecraft 模组构建领域。配 mod 环境、下 JDK、Gradle/Loom/Forge 编译、产 mod、调 MC 启动与窗口位置这类工作，仍由 `dsh-mod-build-auto-approve` 的领域正则与领域词表负责；本插件只处理通用任务（读写文件、起进程、下载、装包、改配置、跑测试）。

两边的 `learned.json` 刻意保持独立，不做合并：合并会让模组域的词（fabric/gradle/mixin…）与通用词混在一张表里，既看不清来源，也无法单独重置。

## 独立性

- 本插件不读取、不修改 `dsh-mod-build-auto-approve` 的任何文件；两边的 `learned.json`、`stats.jsonl` 完全独立。
- 不修改 DSH 的沙箱策略、不动任何全局设置；只挂在 `approval/request` 钩子上。
- 删除本插件目录即彻底清除（词表与统计都在插件目录里）。

## License

MIT，见 `LICENSE`。
