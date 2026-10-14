# 图片任务反馈、继续创作与原生用量修复

状态：**CANDIDATE_READY_NOT_DEPLOYED**。候选三组件隔离验收、最终CI与Security均PASS；未部署。

## 真实任务：已查明什么

详见 [DIAGNOSIS.md](DIAGNOSIS.md)。生产仍为 `1ab3838a0dc40a32973ae06cc440b210f0a9d842`。用户亲自开启后的真实图片任务，本站在北京时间04:47:22发起原生图片调用，约25秒后收到上游HTTP502；未得到图片或上游任务编号。原任务unknown/pending、没有成品；按原生请求键检查usage和结算去重记录均0。用户补充上游积分没有变化，作为用户观察保留。

**请求并非只停留在浏览器；上游502的详细原因没有保存在现有日志中。** 当前没有证据确认供应商最终执行/收费状态。原任务查询确实到达Core，但只是返回同一unknown记录，无法恢复不存在的供应商任务编号。进一步确认缺少供应商侧对应时间的最终请求记录，不能通过重发付费请求替代。

用户要求“查明未执行、未扣费后删除”的条件尚未成立，本轮未删除真实任务。生产查询仅使用限定日志、精确文件和READ ONLY SQL，未调用会驱动持久化/结算的恢复GET，未改变图片/视频开关。

## 根因与最小修改

- `frontend/src/components/video/StudioMediaPanel.vue`：原先未完成任务禁止newTask，同image类型的模式切换直接返回，active隐藏整个composer，提交共用全页busy，迟到响应强制抢占页面。现在可继续创作和切换text/edit/video；生成HTTP按任务跟踪，旧响应只更新原任务/历史，不覆盖新任务。独立新任务仍必须显式报价确认，以独立身份和冻结金额执行。
- 同组件及 `frontend/src/styles/studio-workspace.css`：提交旋转标识、真实阶段、等待时间；unknown明确说明最终状态未确认。查询显示加载、时间、更新/无变化、持续错误。unknown不自动轮询；已知queued/processing/billing_pending最多每10秒、连续12次，失败停止。保留服务端历史和刷新后的创作视图。
- `backend/internal/service/studio_image_billing.go` / `backend/internal/repository/studio_image_usage.go`：新增隔离双任务验收发现SQL覆盖正确交付总额为商品单张价，并覆盖partial Account Stats成本为完整报价成本。复用原冻结报价/交付数量的精确金额用于同一个原生usage INSERT；Apply、余额扣款、幂等键和资金事务不变，没有新增账本或历史数据迁移。

用量缺陷不是此次真实unknown任务的扣费原因：该真实任务根本没有原生结算。此前成功多图任务可能存在用量记录单价与实际总额不一致；本轮不扫描或修写历史账务。

## 版本与云端结果

- 分支：`codex/media-paid-controls`
- 冻结运行源码：`d893690abe47f891aacde8876837ccc0c8b653ac`
- 构建/最终浏览器验收脚本：同上。
- 最终单元测试校正提交：`465d05f35ad2e6d0a3c3fe6e12ec884b927caa0c`。相对运行源码仅修改一个测试文件：显式处理测试DB关闭、保留原冻结金额0.050的精度预期。**运行镜像不是该测试提交，不重新构建。**
- [候选构建与真实隔离验收 Run 38647616053](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38647616053)：PASS。
- [CI 38648428557](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38648428557)：PASS（后端单元/集成、前端、Lint及既有合同回归均通过）。
- [Security 38648428594](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38648428594)：PASS。运行源码Security 38647356199亦PASS。

旧b253镜像的新增体验补验先修正了session等待、首次查询状态更新预期和跨模式加载等待；随后真实发现多图usage金额缺陷，因此旧NOT_PASSED包不作为最终交付。只有运行代码变化后才构建d893。本轮d893初始CI发现测试errcheck与0.05/0.050字符串预期错误，已在测试提交修正；最终CI单独记录，不能把初始失败写成PASS。

## 验收事实

页面来自最终Core内嵌前端，真实Bridge/BFF、PostgreSQL、Redis；仅上游是本地模拟器。无Vite、prototype或浏览器API mock。

- 新增锁定/迟到响应回归先在旧代码失败；本地50项组件、6项API、11项既有浏览器fixture测试通过，TypeScript和定向ESLint通过。fixture仅作为交互证据；本地Go编译未完成，不计PASS。
- [最终任务验收](evidence/native-task-experience.json)：502模拟任务保存unknown，无usage/dedup、余额不变；查询加载、第一次更新、第二次无变化、离线失败持续提示均通过。文生图/图生图/视频切换及刷新保持可用。
- 模拟15秒等待期间，用户主动创建第二笔编辑任务：第一笔1张冻结1.10 CNY；第二笔2张冻结2.20 CNY。两笔各usage=1、dedup=1，记录金额分别1.10/2.20；余额94.10→90.80，准确减少3.30。原502任务仍在，未生成或扣费。
- 此fixture编辑能力为每请求1张，所以2张对应两个正常编辑POST；第一笔文生图1个POST，原unknown仅1个失败POST且后续单元未发送。刷新、下载、切换、重新登录没有增加这些计数、余额变化或结算。
- 图片下载SHA256：`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`，与模拟原片一致。
- [既有媒体回归摘要](evidence/business-regression-summary.json)：1K/1:1文生图3张、2K/3:2编辑2张、普通兼容单视频全部PASS，原片重复下载一致，视频可播放；每任务一次结算，恢复不增加提交。
- 新增SQL定向测试覆盖5张完整交付与2张partial，精确usage金额0.125/0.050、Account Stats基础成本1.75/0.7；最终CI已通过。
- 页面JS/CSS与直接Core资源逐项比对见任务报告assets；35份已取得资源一致。部分导航后重复资源body不可读取明确记录，未冒充全部响应逐字节覆盖。

## 可查看截图

以下均为**本次最终候选＋模拟上游**，黑色图片是固定1像素测试原片，非真实供应商成品。1440/390截图已人工检查，无水平溢出或重叠。

- [桌面提交等待及继续创作](evidence/native-task-waiting-desktop.png)
- [查询加载](evidence/native-task-query-loading-desktop.png)
- [查询失败持续提示](evidence/native-task-query-error-desktop.png)
- [桌面继续创作](evidence/native-task-continue-1440.png)
- [手机继续图生图](evidence/native-task-continue-390.png)
- [手机独立任务结果、实际结算与下载](evidence/native-task-results-390.png)
- [手机unknown任务保留与继续创作](evidence/native-task-unknown-390.png)

## 产物与保留

[最终manifest](evidence/manifest.json) SHA256：`97e63251df6c17ebc401a1cc94330eac0f4518ba225e7393b5ba950cd6d2222e`。

- 完整镜像Artifact：`11933596314`（约213 MB）。小证据Artifact：`11933676059`（约10.6 MB）。
- Artifact名称：`native-media-candidate-d893690abe47f891aacde8876837ccc0c8b653ac`。
- 完整包到期：**2026-10-28 22:35:14 UTC / 北京时间2026-10-29 06:35:14**；小证据早2秒。GitHub临时artifact不是永久备份。
- 本地仅保存小证据：`D:/AI-Gateway/output/image-task-20261015/final-evidence/`；完整包保留云端一份，未重复下载或本地构建。将来获准部署时可取回该精确包，过期前需按既有归档方式保存。
- 本轮大构建/容器栈全部GitHub-hosted；未清理生产、旧候选、回滚资产。最近本地余量C约5.49GiB、D约7.26GiB。

| 组件 | config digest / Image ID | TAR SHA256 |
|---|---|---|
| core | `sha256:46380c683487c313de1f988a2879fe6106768333cf2c7ecd35dc05156b319d7b` | `d58626ef4b6e22c6aad6f51e0d7170f34eb42cf336ad33330754b789c910c3a7` |
| bridge | `sha256:af9114c9d2b6e835f1ea890e421f43bbdb14c1cbffa312e00bc2cd85082d86fa` | `3676629682930051d185cef4ca4c11d5e29f2ae2e5ca7412df46c73e134771c3` |
| bff | `sha256:5fee96b658de52b4b58c2b2476c58b307c6b610ec6a7276b1e6b6cd5b2caf719` | `71a323403507e0ed515c8b13e70352f5cdffaa4dd7b57d6f39ef430f259f0135` |

各组件均linux/amd64、source=d893；现有受控paid-controls配方构建三组件，Bridge/BFF业务源码未改。OCI manifest digest与config关系、精确TAR文件名和字节数见manifest，不能混用两种摘要。

## 部署与真实任务边界

本轮没有部署、开关变更、商品/售价/mapping修改、真实供应商调用、补扣、退款或真实任务删除。正式Handoff/Constraints保持原文；本目录是执行证据交接。

候选准备门槛：身份与内嵌资源、三组件健康/网络、关键交互、模拟交付/原生账务PASS；最终CI与Security均PASS。生产公网HTTPS/边缘缓存/登录/回退核对本轮N/A（未授权部署），不能引用候选PASS冒充线上生效。

下一步需要单独部署授权，沿用现有生产拓扑、保存现场三组件及配置后定向切换；没有数据库schema变化，不整库恢复，必须保留现有receipt、journal、原片和未知任务，不重发原POST。当前用户亲自开启的生产开关未被本轮改变，不能拿候选隔离环境最终关闭状态代替生产状态。旧502任务不会因UI部署自动完成或消失。
