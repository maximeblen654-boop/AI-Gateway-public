# 比例配置、模型被动状态与 Banana 准备：最终交接

状态：**CANDIDATE_READY_NOT_DEPLOYED**。2026-10-16 北京时间。

本轮已完成非生产实现、真实三组件隔离验收与候选准备。未部署、未修改生产商品/价格/mapping/Group/Key/付费开关，未调用真实供应商生成。最后已核实的生产运行仍为4f10，图片开启/视频关闭；本报告不替代下一次部署时的现场核对。

## 1. 固定身份与可复核入口

- 分支：`codex/media-paid-controls`
- **运行源码、构建及最终验收脚本：`15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`**。后续本报告归档提交不属于运行镜像源码。
- [构建及最终三组件验收 Run 38784147330：PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38784147330)。UTC 2026-10-15 18:15:42开始，18:28:34完成，约12分52秒。
- [CI 38784119246：PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38784119246)
- [Security 38784119244：PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38784119244)
- 完整镜像 Artifact **11997437376**，`native-media-candidate-15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`，214112014 bytes。
- 小证据 Artifact **11998540803**，`native-media-evidence-15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`。
- 完整候选到期：**2026-10-29 18:27:57 UTC / 北京时间2026-10-30 02:27:57**；小证据早2秒到期。GitHub临时artifact不是永久归档。
- [最终PASS manifest](evidence/candidate/manifest.json)，SHA-256：`bd499f3dc9e7311c240e0e04539579711b9d02dbeeb2272b4fa790d2cf7c29a6`。
- [健康与网络](evidence/candidate/acceptance.json)、[镜像内运行文件摘要](evidence/candidate/runtime-files.json)、[隔离组合](evidence/candidate/combination.json)。组合含模拟器和合成配置，**不可复制到生产**。
- 公共JSON省略逐笔任务/用户/账户标识和余额明细，网络信息只保留附着结论；完整原始隔离证据保留在本地及既有受控workflow artifact。截图来自该workflow创建的Synthetic Account/商品，不含生产账户会话。
- 本地小证据：`D:/AI-Gateway/output/media-options-status/final/native-candidate-output/`；可审核副本：`D:/AI-Gateway-public-staging/docs/operations/2026-10-16-media-options-status/`。完整镜像只在上述云端artifact保存一份，本地未下载第二套TAR。
- 旧0b0308cae candidate未通过最终统计断言，不是本次可部署候选。修订版源于真实运行缺陷，不是换标签复用旧镜像。

## 2. 管理员比例配置

- 图片增加1:4、4:1、1:8、8:1快捷选择/取消，全部原预设保留；视频快捷能力不扩大。
- “自定义比例”支持输入、添加、移除、trim、去重和无效格式反馈，逗号输入保持兼容；只使用原`capabilities.aspect_ratios`。
- 不自动修改已有商品、售价、发布快照、模型映射，也不因快捷选项而承诺所有模型支持它。
- 真实Vue五步操作→保存请求→数据库重读→隔离发布→报价→模拟文生图/编辑已通过。未发布3:5被客户报价拒绝；发布后使用1K/3:5/1张，两条上游POST均实际发送`resolution=1K, aspect_ratio=3:5, n=1`，没有前端猜像素，也未预填技术size_mappings。
- 两个商品ID、各自规格/单价及视频配置保持独立；文生图与编辑各生成一次，原片SHA-256均为`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`，原生usage/dedup各增1，各结算合成价0.70CNY，无冻结余额；刷新不增加POST或结算。

## 3. Oil UI 与真实被动状态

Oil UI 0.22.2已实际读取并应用，三方案保留在[设计比较](DESIGN.md)及[交互设计稿](designs/style-explorer.html)。用户选定 **A · 简洁标签**，正式Vue已实现。模型右侧紧凑文字标签，悬停/焦点/触屏查看详情，颜色不是唯一表达；模型选择、重新报价、键盘操作保持。手机浮层在视口内限高。

数据复用`ChannelMonitorV2Service/Repository`，从既有授权商品目录投影，按**平台+当前Key的Group+requested model**关联，90分钟窗口、原生最小样本与完整覆盖、10分钟新鲜度；一次目录最多一次矩阵读取，750ms独立预算，失败降级中性，不影响目录/报价。未暴露原始请求数量、凭据、原始错误、其他用户身份，也不声称具体Account健康。

生产只读事实：当前监控运行模式V1，V2没有可用水位/近期聚合，Group31有多个Account。所以当前生产配置下未来部署此功能仍应显示“暂无状态数据”；本轮没有切换生产监控或建立主动收费探活。旧日志缺少requested_model，不猜测回填。

最终镜像＋真实PostgreSQL验证：V1中性、无水位、错误Group/平台/模型、不足50样本、100样本20错误、过期、图片/视频隔离与会话权限均PASS；原合成监控数据已还原，检查本身零新增供应商请求。[原生状态报告](evidence/candidate/native-passive-status.json)。截图里的20%是隔离合成统计，不能用作生产健康结论。

新增统计修复：明确502无交付客户失败使用HTTP200任务信封，原生Ops可能当作恢复；接入已有in-band逻辑失败标记。最终成品验收又发现ForwardImages failover只提供事件数组，初版只读单值状态漏记；现复用原生`applyOpsUpstreamFieldsFromContext`解析最后尝试，4笔502准确记4条status502/上游502，Account/Group/requested_model正确，重复查询不增。partial和unknown不冒充零交付终态，不改资金合同。修复前event-only反例FAIL，修复后PASS。

## 4. 定向验收与截图

- 本地74项Vitest（13比例、10模型选择、51面板）PASS；Vue类型和受影响Lint PASS。
- 原定向浏览器7项×3轮21/21 PASS；手机遮挡修订后1440/390×浅/深4项另验PASS。
- Go真实Ops中间件/event-only/最后断线/鉴权错误/重复/partial/unknown定向回归PASS；最终CI与Security PASS。
- 最终镜像实际文生图3张、编辑2张、普通兼容视频1条、原片下载、原生一次结算PASS。
- 20笔相关异常回归：成功4、partial502 4、明确502 4、断线4、超时4；四个客户资金独立，8笔交付结算，失败/未知无扣款或占用，重启/查询/重复提交不重发生成。保留104笔资金及1870规模旧证据，未重复整套。
- 无Key网页登录、任务等待/unknown、继续创作、原任务恢复回归PASS。测试用普通模拟上游502 unknown与Image2Pro明确零交付终态是不同合同，未混淆。
- [白名单化联调与合成资金验证摘要](evidence/candidate/integration-summary.json)。所有当前截图直接来自最终Core内置前端，无Vite、无浏览器API mock、无真实供应商。

| 页面 | 桌面 | 手机 |
|---|---|---|
| 比例与自定义 | [1440px](evidence/candidate/native-aspect-options-desktop.png) | [390px](evidence/candidate/native-aspect-options-mobile.png) |
| A模型状态浅色 | [1440px](evidence/candidate/native-model-status-1440-light.png) | [390px](evidence/candidate/native-model-status-390-light.png) |
| A模型状态深色 | [1440px](evidence/candidate/native-model-status-1440-dark.png) | [390px](evidence/candidate/native-model-status-390-dark.png) |

## 5. Banana准备，不替用户配置生产

完整可填写清单见[BANANA_TEST_PLAN.md](BANANA_TEST_PLAN.md)。精确目录ID`Nano-banana-2.1`沿现有Account/ForwardImages合同；用户确认的极端比例不再重复质疑。

建议独立banana-test分组/本人测试Key，保留Group31/Account77/GPT商品。真实采购金额、实得积分、1K单件消耗、正数售价、模型权益与路由需用户确认。通用文档n=1～4不是精确Banana模型的多图承诺；未确认前单请求1张，多购买数量继续现有多执行单元聚合。

最小未来真实测试是1K/1:1/1张文生图，须单独授权。当前网页Bridge固定图片Group，创建banana-test Key不会令网页自动切换分组；可先用原生API验证独立测试Key，若验证网页应使用现有隔离栈或另审路由。原生API成本与Studio客户售价不能混同。

用户已明确“没有保存草稿”，保存故障调查已结束，未替用户重存或修改生产草稿。

## 6. 修改范围与下一步边界

主要文件：`MediaProductEditor.vue`、`MediaTokensField.vue`及测试；`StudioModelPicker.vue`、`StudioMediaPanel.vue`、`studio-workspace.css`、`api/studioMedia.ts`及测试；`studio_passive_status.go`、授权图片/视频catalog接线、Wire依赖；`studio_images.go`原生Ops标记及测试；现有native-media-e2e的比例/状态脚本。细节见[IMPLEMENTATION.md](IMPLEMENTATION.md)。未新增数据库schema，未重写执行/账务/模型映射。

候选具备进入下一次部署审核的条件；**生产部署必须另行授权**。下一次应核对实际4f10或更新的现场身份、保持failed/not_charged历史终态与原生结算保护、保护图片当前状态和视频关闭，按现行受控三组件切换/网络附着及条件恢复流程。不能自动降级到不认识终态的2bd，不恢复整库或覆盖journal。生产监控V2是否启用另由用户决定，本候选不包含自动启用。

manifest中的legacy false是既有managed模式启动边界，不是授权本轮修改生产图片有效开关。生产HTTPS、登录、开关和恢复资产须到获授权部署时现场复验；不能用本轮隔离PASS冒充现网验收。GitHub runner已结束，其127.0.0.1地址不再可访问。

发布守卫适用性：ART-01本轮PASS（三镜像、TAR、OCI/config、实际运行文件、Core资源、业务隔离验收）；PUB-05隔离范围PASS；PUB-01/02/03/04/06生产切换项本轮N/A（未授权部署），下一次部署仍需逐项核对，不能视为生产PASS。

Constraints原文未改（SHA-256 `88f1088b2f7c99d3461b93749211ca02ec624adb74c14b9ff6628cf32a5bafea`）。本地未做大型镜像构建；仅保留报告，清除已归档的重复临时截图，未清共享缓存/候选/回滚/持久数据。

## 7. 完整组件指纹

### core

- source SHA: `15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`
- Image ID / config digest: `sha256:b458b116708d7824e1ec1399625479fd21618c3defc832a90c1a9ae35e2fa317`
- OCI manifest digest: `sha256:a1f4826c236011f8020a081406486d93ce0d76dee28489ff75b54bdd229f2af8`
- TAR: `core-15da7cbbaefe4a3ea11fda6dfd983e030db44b4a.tar.gz`
- TAR SHA-256: `e51c5cbb9c27c9b1890fcf308c4a337f37c569a28293cb8a989e14c3416c8e8c`
- bytes: 62010768

### bridge

- source SHA: `15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`
- Image ID / config digest: `sha256:c327e3b6fcf172e518b91bdce524f76db812698e169ae7a23b701fad3abc0332`
- OCI manifest digest: `sha256:f18a9c2da3138ae466a4cbb8888402030672f688392db4d68b8435299955c42b`
- TAR: `bridge-15da7cbbaefe4a3ea11fda6dfd983e030db44b4a.tar.gz`
- TAR SHA-256: `18c59316ec6b39e4f1ab5f411c10560b165cf13b499a5ccf015a09c88cb0d27b`
- bytes: 19126913

### bff

- source SHA: `15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`
- Image ID / config digest: `sha256:378533b6cec626c4712d511d2b1630ae99b0bb74e47b9b2e40b60b9618e0918e`
- OCI manifest digest: `sha256:eb85bf11cdf734738a41b2c378ebe43659b7232b5f9ba293139bb48d0af0361d`
- TAR: `bff-15da7cbbaefe4a3ea11fda6dfd983e030db44b4a.tar.gz`
- TAR SHA-256: `e12fba669741b4a4e398da317007c82fbc37432ea8aec4ea521b7aadfc1e812b`
- bytes: 120288191
