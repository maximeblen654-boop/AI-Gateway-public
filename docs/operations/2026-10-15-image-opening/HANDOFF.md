# 图片开放尝试与开关 UI 后续需求 — 2026-10-15

**当前状态：`BLOCKED_IMAGE_QUOTE_BINDING_BOTH_DISABLED`。图片没有完成开放；图片、视频全局付费提交均已恢复关闭，服务正常。**

这是一份供 ChatGPT / Codex 接续读取的脱敏执行记录，不是新的运行版本，也不替代正式长期 Constraints。不要把“容器健康 / readiness=true / 目录可见”当成真实生成已验收。

## 当前运行身份

| 组件 | 运行源码 | config digest / Image ID | 本机 OCI manifest digest |
|---|---|---|---|
| Core | `15d09689abc0b7e07269692d50e78f83859d1fb6` | `sha256:c1496ec64f21dc2a4d7539734f36aa07579feab7f00eba8790bb3620cf4a35a3` | `sha256:707da370b94f85ec548a0eae4b11f8648016d1262bfdd792bb0c800da6d77ef5` |
| Bridge | `b2fcdac93afa6ae194ee81801a9b37813f8f39eb` | `sha256:dd01aa29e152f589679e5065037459240aeb8ddfe3ec853c16033006fe67acda` | `sha256:caa90294c79db4253b8cdb97bb920a255afc9c3797555d0c18d55e6a7ffc9e25` |
| BFF | `b2fcdac93afa6ae194ee81801a9b37813f8f39eb` | `sha256:e498b97225bfc15e286af26bff30ec5c8d84526adfdbcd8231ebf7bad50e3f21` | `sha256:cc7ae2120821e12ef687847408718bc2547c2f12ab9c05b2dd6609bb41e0344a` |

本次没有构建、拉取新镜像或更换运行代码。源码工作树与旧候选/回退资产均保留。本次 Git 提交只归档文档和脱敏证据，不能当作新运行源码 SHA。

## 授权及实际动作

用户授权直接开启图片供其自行生产测试，视频保持关闭。发现三层开关是进程启动环境后，用户另明确批准“仅使图片开关生效”，允许使用原镜像短暂重新创建 Core → Bridge → BFF。

实际变更只包括三组件 `STUDIO_IMAGE_PUBLISHED_SUBMISSION=false → true`。Compose 渲染差异已核对；`STUDIO_VIDEO_ACCOUNT_SUBMISSION=false`、Core 的 `IMAGE_RECEIPT_WORKER_ENABLED=false` 和其余配置保持不变。没有启用旧回执后台恢复。

开关短暂生效后，非付费报价失败。按用户给定的异常处理，恢复原 Compose 配置，使用同一组三组件镜像再次定向重建，图片和视频均回到关闭。没有整库恢复，没有覆盖 Redis、journal、原片或业务配置。

时间为北京时间：

- 2026-10-15 00:24:51 开始使开关生效；00:25:26 三组件健康并完成服务器检查，约 34.8 秒。
- 00:30:42 完成真实 Vue 页面报价失败复现。
- 00:31:44 三组件恢复关闭后均健康。
- 00:32:46 服务器最终状态检查通过；00:33:53 登录后图片/视频 readiness 均确认 false。
- 以上为服务操作与检查时间，不承诺每个用户请求恰好中断相同时长。此前 Codex 认证中断、重新登录等等待不计入容器操作时长。

## 真实生产验收结果

| 检查 | 短暂开启后的结果 | 最终结果 |
|---|---|---|
| 图片 readiness | HTTP 200，`paid_enabled=true` | HTTP 200，`paid_enabled=false` |
| 视频 readiness | HTTP 200，`paid_enabled=false` | 仍为 false |
| 图片客户目录 | HTTP 200，1 个已发布图片 offer | 商品及目录保留 |
| 文生图 | 入口可见，“未开放”提示消失 | 因恢复关闭，提示重新显示 |
| 图生图 | 入口、参考图上传控件、素材 readiness 可用 | 不开放真实提交 |
| 文生图报价 | **HTTP 409，`image_binding_unavailable`** | 未绕过 |
| 参考图编辑报价 | **HTTP 409，`image_binding_unavailable`** | 未绕过 |
| 真实 Vue 操作 | 页面“开始生成”先请求报价，并显示报价/素材/模型/权限校验失败；没有进入生成提交 | 未制造成功结果 |
| 历史列表 | HTTP 200，当前验收用户 0 个任务 | 页面可打开；未补造历史 |
| 原片查询/下载 | 无现成任务/结果，**NOT_TESTED** | 不声称本次已通过下载验收 |

报价来自真实 Core / Bridge / BFF，没有 Vite、prototype 或浏览器 API mock。直接报价与页面报价使用同一目录 offer；最小请求如下，offer ID 省略：

```json
{"resolution":"4K","aspect_ratio":"16:9","duration_seconds":0,"quality":"","count":1,"images":0,"videos":0,"audio":0}
```

编辑报价只将 `images` 改为 1；不上传素材，不发送供应商请求。当前发布目录明确包含上述规格，不从旧 1K/2K/4K 快照臆造参数。

重要边界：BFF 对 Core/Bridge 失败做了泛化处理，所以这个 409 **尚不能定位为 mapping、余额、商品配置或尺寸错误**。根因尚未确定；不要修改 Account mapping、售价、规格或发布状态来试错。下一步应先取得原生报价失败的具体原因，并用隔离数据定位；不可把此记录误读成要求重做适配器或底座。

## 数据和服务保护

- Account #77 当前 1 份商品；原 `sales.enabled=true` 保留。开关操作前后完整媒体配置、映射摘要一致；没有保存、删除、合并、改名、改价或发布商品。
- Account 销售标记、已发布配置、全局付费提交三层不同：现在前两者保留，最后一层关闭。
- Core/Bridge/BFF 镜像身份不变，均 healthy；Bridge/BFF 已附着最终 Core 网络命名空间。
- PostgreSQL、Redis、无关旧 sidecar 的容器 ID 不变；Caddy active；挂载和原环境恢复。
- 迁移记录摘要未变，没有执行新增迁移；无数据库/Redis/原片恢复。
- Agent 未发送 Generate/Prepare、真实供应商调用或收费请求。进行了报价检查与正常登录/会话交互，不将它们描述为“完全没有持久化可能”。
- 本轮未修改正式 Handoff 或 Constraints；此执行记录交由 ChatGPT 后续维护正式交接。未提交无关脏工作树。

## 下一阶段：用户提出的 UI 开关与开启前检查

**仅记录需求，尚未开发或部署。** 用户希望在管理员 UI 控制图片/视频开放，并在开启前先检查，通过后才允许开启。

建议以本次真实失败作为必要反例：健康、目录、开关值全部正常，报价仍可失败。最低检查应使用已有原生服务核对：

1. 对应 Account、canonical mapping、已发布依赖、销售标记及权限有效。
2. 客户单价严格大于 0，规格合法，文生图/编辑配置按实际合同独立校验。
3. 按目标身份验证非付费报价、结果存储/私有素材配置及各组件有效开关，给出具体失败原因。
4. 检查结果绑定当次配置版本；检查后依赖变化不得复用旧 PASS。服务端应执行同一检查，不能只靠浏览器按钮禁用。
5. 保持图片与视频互不串开，明确显示“请求状态”与“实际生效状态”，失败保留关闭；不自动发布商品、改价、补余额或开启视频。
6. 检查不发真实收费探针，不以非付费 PASS 保证供应商必然生成成功。实际付费验证由用户另行决定。

目前文生图与图生图共用图片全局开关、视频另有开关。是否需要把两种图片用途再拆开，尚未定合同；不要仅根据口语中的“生图/图片”擅自增加第三套底层控制。当前开关只在启动时读取，未来 UI 方案必须解释怎样真实生效，不能只保存一个布尔值并宣称已经开启。

优先处理本次报价阻塞，再评审开关 UI 与检查流程。不要直接从本文启动生产变更或付费测试，也不重做已完成五步 UI、作品桌、计费和适配器。

## 证据

- [脱敏机器摘要](evidence.json)
- [真实页面报价失败截图](image-quote-blocked.png)：短暂开启阶段；截图捕获在失败提示已经出现、历史刷新尚在收尾时，不代表生成处理中。
- [最终图片已恢复关闭截图](final-image-closed.png)：当前状态。
- 本地详细记录：`D:/AI-Gateway/output/image-open-20261015/`。包含当前配置保护摘要与只读结果，未将私有原始 Account 配置、凭据、Token、内部产品 ID 或完整环境变量上传 GitHub。

**禁止交接成 `IMAGE_WORKBENCH_OPENED_VIDEO_STILL_DISABLED`。实际终态仍为 `BLOCKED_IMAGE_QUOTE_BINDING_BOTH_DISABLED`。**
