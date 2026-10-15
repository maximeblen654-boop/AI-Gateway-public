# 模型生命周期、逐商品故障隔离及明确选择发布：最终交接

状态：**CANDIDATE_READY_NOT_DEPLOYED**。2026-10-16。全部证据来自非生产隔离环境；本阶段未连接或修改生产、未调用真实供应商、未恢复生产图片开关。生产事实沿用此前已核实的4f10、图片requested=true/effective=false、视频false/false，未在本轮重新核实。

## 产品结果

**能。** 如果GPT下架，而Banana或其他商品已经合法发布、通过必要授权且依赖正常，客户仍可明确选择它们、重新报价确认并生成。不是只过滤前端：最终镜像实际经BFF→Bridge→Core向本地模拟供应商提交、交付原片并完成原生一次结算。

- 同Account 53个目录模型不要求全部配置。最终真实管理员页面中：已有2个Published商品，3个Draft商品（其中一个未完成）；仅勾选一个商品发布，HTTP200，Published仍2个。未完成草稿、未选中的Published/Offer和另一个草稿价格保持不变，发布产生供应商POST为0。
- 单商品下架、归档、恢复、显式重新上架采用CAS；恢复仍为下架。未配置模型可隐藏，已填写规格价格但未发布商品可归档，历史任务和结果不硬删除。归档/发布确认展示目标与影响范围，不修改原生Key、Group或Account路由。
- 商品目录、报价、提交和PaidControl按商品依赖与已通过预检的Offer授权分层；一个坏商品不关闭其他健康商品。全部无可用商品时拒绝新生成；共享资金、权限、凭据/路由及存储条件仍受保护。新商品/新依赖不能借用旧PASS。
- 管理员按商品显示“已发布配置当前不可售”、具体原因和处理动作；分别展示草稿保存、草稿校验、Published、Account销售与全局付费条件。保存草稿或草稿PASS不等于可售。
- 成功且可信的完整目录才更新可用性。失败、partial、分页未完成、空/畸形响应保留最近成功目录，不能据此推断全部下架。目录恢复不解除人工下架。
- 客户旧模型失效时保留提示词、素材和历史，显示改选提示；不自动换模型、重试或重新扣费。旧报价在下架→归档→恢复→重新上架之后仍409，不会复活。
- 原生API Key路径独立：同Account的原生支持模型`gpt-image-1`在Studio商品下架及Published不可用两种情况下均经标准接口HTTP200、各一次模拟供应商请求；Studio报价409。受保护`canvas-image-01`仍400 `studio_task_required`，没有绕过任务限制。

## 固定身份与验收

| 项目 | 身份 / 结果 |
| --- | --- |
| 三组件运行源码 / 构建脚本 | `6f02fdc17a923aa17576f0803305b925b29e36dd` |
| 最终验收脚本 | `7c5976dd5b67a203b262471f91a5400cdf2d8be9`，其后证据提交不是运行源码 |
| 构建 / 完整镜像 | [38808850222](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38808850222)，Artifact **12006959480** |
| 最终镜像验收 | [38814836926 PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38814836926)，证据Artifact **12009644321** |
| 最终CI | [38814835730 PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38814835730) |
| 最终Security | [38814835717 PASS](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38814835717) |
| 最终PASS manifest | [manifest.json](manifest.json)，SHA256 `65d80ee5639b5133f93355a20610177bd50978e59820aa2b4aabbf9cdbce499a` |

三镜像只构建/导出一次。最初完整包内manifest因测试脚本失败标记NOT_PASSED；**必须配合本目录最终PASS manifest使用**。最终manifest.images与原构建manifest.images完全相等。补验只改测试/harness，未换镜像；失败原因完整保留在[BUILD.md](BUILD.md)。不能把首次失败run报成PASS，也不能把7c脚本标成镜像源码。

### core（linux/amd64）

- source：`6f02fdc17a923aa17576f0803305b925b29e36dd`
- Image ID / config digest：`sha256:6aa2dab5c9c7d3ecf73857858f747ca71cbe8df013d4e6d7d79b0d141947415c`
- OCI manifest：`sha256:edb9b80a1c821eba7cd5332ef0184a80e0615afad19aa41fdfdfc577f268ab5f`
- TAR：`core-6f02fdc17a923aa17576f0803305b925b29e36dd.tar.gz`（62047888 bytes）
- TAR SHA256：`c1dcc6d3b268fcf85ef436426cfb3744ed71f35a0783f12f350ff8383f3a294f`

### bridge（linux/amd64）

- source：`6f02fdc17a923aa17576f0803305b925b29e36dd`
- Image ID / config digest：`sha256:049df50b916c4bacbabad298b9c424161b7c9d50a0ba2d188a02037712fbb6d5`
- OCI manifest：`sha256:c1806c7d9c8f599c251c81cf7131f6fea7453666289b3e077bf18cd3d350e1d3`
- TAR：`bridge-6f02fdc17a923aa17576f0803305b925b29e36dd.tar.gz`（19120086 bytes）
- TAR SHA256：`d9a87c5c4c1f76e68069e523d8cc1deec014f695fb4d45fe39db272d0e35eb2f`

### bff（linux/amd64）

- source：`6f02fdc17a923aa17576f0803305b925b29e36dd`
- Image ID / config digest：`sha256:0838f59fee49b936f1d0b4ec288d780d2dda88bbfefeb387796ce0b5f2761574`
- OCI manifest：`sha256:276eda8849ea2664b9969e2e37b7cc351d3665d48aa9ae548b3a1244be808a74`
- TAR：`bff-6f02fdc17a923aa17576f0803305b925b29e36dd.tar.gz`（120275212 bytes）
- TAR SHA256：`dcc221a60a47b4bb0d8e5416146272082723021d516fabfa4d7af6c8d14c8173`

## 实际验收证据

- [逐商品隔离、选择发布及原生API对照](evidence/native-model-lifecycle.json)：目标不可用时健康同Account商品完成1张模拟图片；余额100→99.975，usage=1、dedup=1、冻结余额0。重复提交、查询和下载没有增加POST/结算；下架已完成商品后原任务和原片仍可读，SHA256一致。另一个同Group Account仍可报价。
- [完整1870组合](evidence/native-paid-controls-scale.json)：三次管理员检查浏览器耗时1244/719/694ms，服务端718/648/636ms；正式Apply二次检查896ms。检查本身供应商请求0，视频保持关闭，隔离环境收尾两者关闭。
- [共享权限/资金/存储与配置失效](evidence/native-paid-controls-verify.json)：余额不足、原生权限拒绝、映射变化、旧PASS、BFF故障均拒绝；图片/视频独立。
- [20笔受影响回归](evidence/native-image-finality.json)：OK、502、部分成功502、断线、超时各4笔；原生余额守恒、一次结算、未知与明确失败语义、重启/重复查询不重发。未重跑旧104笔整套。
- 图片文生图、编辑、多图、单视频、原片交付下载及冻结报价回归通过，完整报告在最终小证据Artifact。视频生命周期共用服务/单元回归通过；主要新增浏览器生命周期端到端场景针对图片，不声称生产视频已开放。
- 定向Go包、受影响HTTP/仓储测试、前端137项原定向测试及后续选择发布用例、vue-tsc、变更文件ESLint通过。最终CI覆盖最新测试提交。前期本地浏览器用例与最终Core镜像证据分开记录，不以fixture代替成品。
- [三组件健康与共享网络](evidence/acceptance.json)、[运行文件哈希](evidence/runtime-files.json)、[隔离组合配置](evidence/combination.json)。后者只供复核，不可复制为生产Compose。浏览器资源逐个与Core直接响应比对相等，报告明确`vite=false`、`browser_api_mocking=false`。

## 可查看截图

均来自本次最终Core镜像，数据为合成商品和模拟上游。Runner已结束，无可用公网/本地集成地址。

- [桌面：下架确认及影响范围](screenshots/native-model-lifecycle-admin-confirm.png)
- [桌面：归档和分层状态](screenshots/native-model-lifecycle-admin-archived-list.png)
- [390px：归档与状态](screenshots/native-model-lifecycle-admin-archived-list-390.png)
- [53个模型、明确选择发布](screenshots/native-model-lifecycle-selected-publish.png)
- [客户桌面：模型不可用但创作内容保留](screenshots/native-model-lifecycle-customer-unavailable.png)
- [客户390px：保留输入并提示改选](screenshots/native-model-lifecycle-customer-unavailable-390.png)
- [深色桌面](screenshots/native-model-status-1440-dark.png) / [深色390px](screenshots/native-model-status-390-dark.png)

## 保存位置与有效期

- 本地最终小证据：`D:/AI-Gateway/output/model-lifecycle/final/native-candidate-output/`。
- 可公开脱敏交接、manifest与截图：`D:/AI-Gateway-public-staging/docs/operations/2026-10-16-model-lifecycle/`。
- 完整镜像仅云端一份（238,968,281 bytes），Artifact12006959480到期北京时间**2026-10-30 05:25:27**；最终小证据12009644321到期**2026-10-30 06:14:38**。Artifact是临时保留，不是永久备份。GitHub文档保留manifest和脱敏证据；授权部署需要时再取一份完整包，避免C/D重复下载。到期前须取回，过期不能假称仍可下载。
- 本轮无本地大型构建、无共享缓存/正式候选/回退资产删除；未修改Constraints。

## 后续唯一受控操作链与未执行事项

见[RECOVERY_PLAN.md](RECOVERY_PLAN.md)：**另获本次候选部署、Account77原GPT Published依赖恢复及条件恢复图片授权后**，核对现场→部署固定6f三组件→候选工具dry-run原PublishedGPT→完整SHA/备份/CAS重新校验原子修复→完整1870非付费报价及预检→按授权二次检查恢复图片，视频关闭。

Account77已有脱敏离线投影1870规格验证PASS；原Products/Offers、两商品Draft及revision/validation均不变（[离线报告](account77-offline-recovery.json)）。这不是当前生产读写证据。Banana仍仅草稿，本轮未发布、改价或恢复生产开关。

**回退限制：新生命周期和逐商品依赖JSON写入后，旧4f/3b严格解码器不兼容，禁止盲目降级或整库恢复。** 部署前必须重新确认现场兼容回退条件；写入后使用兼容版本并保留业务数据。无新增数据库schema或migration。原生迟到首次结算/负余额合同保持不变。

[实施范围](IMPLEMENTATION.md) · [构建溯源](BUILD.md) · [发布守卫适用性](RELEASE_CHECKS.md)。本轮完成后停止，等待单独生产授权。
