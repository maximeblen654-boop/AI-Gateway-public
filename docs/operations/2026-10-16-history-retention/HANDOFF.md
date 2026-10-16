# Studio history visibility and 72-hour retention

状态：`IMPLEMENTED_NOT_DEPLOYED`

## 本轮实现

- `StudioMediaPanel.vue` 默认隐藏已经确定为 `failed`/`released` 且账务已落到 `billed`/`not_charged` 的任务；按钮显示当前已加载的失败数量，可切换显示/隐藏。`unknown`、处理中、等待恢复、待结算和 `partial` 不进入失败筛选。
- 保留现有任务卡片、米白背景、大圆角和图片展示；按钮复用现有 CSS 变量，支持桌面、390px 手机、键盘焦点及深色主题。
- 新图片结果由结果存储的不可变元数据按 72 小时过期；清理时同时删除图片和元数据文件并返回删除数量/字节数。旧 PNG 没有元数据时继续按原文件时间兑现 7 天承诺。
- 图片服务启动时执行一次结果清理，并每 6 小时重复执行；使用既有锁和元数据校验，不扫描删除其他业务目录。
- 任务 journal 提供 owner-scoped `cleanupExpired` 维护入口：仅允许过期、已结算成功或明确 `failed/released + not_charged` 且无结果文件的任务，在调用方确认终态后归档显示 journal。原 quote 和 dispatch claim 保留，未知/待结算任务跳过。未接入跨 owner 自动删除，以避免绕过账务/恢复证据检查。

## 验证

- `node --test studio/bff/image-binding.test.mjs studio/bff/image-result-store.test.mjs`：25/25 PASS。
- `frontend/src/components/video/__tests__/StudioMediaPanel.spec.ts`：60/60 PASS。
- `pnpm run typecheck`：PASS。
- 受影响 Vue 文件定向 ESLint：PASS。

## 生产边界

本轮未部署、未删除生产历史、未改变商品/价格/mapping/Account/Group/API Key、未改变图片或视频付费开关，未发送真实供应商请求。

## 交付条件

需要在候选构建中补充隔离浏览器截图、三组件 CI/Security 和维护入口的现场保护证据后，才可申请单独生产部署。生产部署前必须先盘点到期任务、确认回退版本能读取归档/原始 receipt，并由受控维护作业逐 owner 调用清理入口。

## 旧 GitHub 产物

已完成只读引用盘点。未执行未过期 Artifact 删除：当前候选及旧回退证据虽有部分未在本地文档中出现，GitHub Artifact 删除不可恢复，需逐项确认副本/引用后再由独立运维授权处理。

## 隔离视觉证据

- 桌面默认隐藏失败：[failed-hidden-1440.png](failed-hidden-1440.png)
- 桌面显示失败：[failed-shown-1440.png](failed-shown-1440.png)
- 390px 默认隐藏失败：[failed-hidden-390.png](failed-hidden-390.png)
- 390px 显示失败：[failed-shown-390.png](failed-shown-390.png)

截图来自本地隔离 Vite fixture `scenario=failed`，不含生产数据，也未连接真实上游。

## 候选结果

- 固定源码：`875eeef7644993f08de04b0ccdcf2179627848be`
- Candidate Run：`38851646539`，Acceptance `PASS`，状态 `CANDIDATE_READY_NOT_DEPLOYED`
- CI：`38850505697` PASS；Security：`38850505696` PASS
- 完整候选 Artifact：`12025273779`（约242.5 MiB）；小证据 Artifact：`12025243949`
- manifest 记录的组件身份：Core config/image `sha256:eff74c4a2c0f9db928dd656e5c08c0a2326c0127f34150c0b6dde7b97918dc9b`，OCI manifest `sha256:ddebbdcaaa11ad9d5c0de456560d3055af5e1edacd75b296539c17fe5b177d98`，TAR `core-875eeef7644993f08de04b0ccdcf2179627848be.tar.gz` SHA-256 `f76f535d004c51d287736e12d905ce87f4b13e0fa1026b01cfea842f0f9e4d79`；Bridge config/image `sha256:e2d0ba88f9094f31816baf9f557ba3ea8869cffc9b1854cf8117d51ba76c10f7`，OCI manifest `sha256:b6b0439b5829db1df733d08e8a860fbe520f11fae7d3e96e55b2c3e1a4234ceb`，TAR `bridge-875eeef7644993f08de04b0ccdcf2179627848be.tar.gz` SHA-256 `5c8e0a9ff7a76a3f578e2b51900b22fd76e2968bfbe4ea694ec78e935303419a`；BFF config/image `sha256:6fbab1d8126bd1c0de17ca3d14a2cd609989487271865e122b1984c91b7dba9d`，OCI manifest `sha256:f053577130e22fb42a80be3c9147474d9e2220fc60249d11bf1ce0a420a8f727`，TAR `bff-875eeef7644993f08de04b0ccdcf2179627848be.tar.gz` SHA-256 `039ee6bd2297f0204d5963ccc48fa527af6cc30cda6fae18ce8d4338edfb11fd`。
- 组合验收来自最终 Core 镜像，三组件 healthy，Bridge/BFF 使用 Core network namespace；无生产动作、无真实供应商请求。

候选完整包仍只保留 GitHub 一份；本地未下载完整镜像。

- 最终 manifest SHA-256：247bb9a3445028ae0243d8de60d757e0ac313f0b6fb2159056321946cb52eaa5。

## 自动历史清理补丁候选

- 新运行源码：`a8f5f0f21c3fe092c815400c27b9fc19d789861d`
- Candidate Run：`38859091998`，Acceptance `PASS`，状态 `CANDIDATE_READY_NOT_DEPLOYED`
- CI：`38857828665` PASS；Security：`38857828630` PASS
- 完整 Artifact：`12029375171`，小证据 Artifact：`12029256517`，均预计 2026-10-30 到期
- Manifest SHA-256：`a4b873c32489c0b65cf6a284cee360dcf274424176f3c2793a498a24df5d9180`
- Core config/image `sha256:821100b48b83468b0ee7fff361d352675eaef5bc3b6d27bcc28db59d46ad8bb5`，OCI `sha256:10a764873e12edb0c0689c4c7511e0926b2422a3ccdd09940c90cf83a8ba1432`，TAR SHA-256 `1847a07b52d05f6d0a01a77cf14bdb739f6ad0b291d8045a9290fa2a04683e6a`
- Bridge config/image `sha256:fb2b01a2bec9c537113fb2531a4de14aafa78f125ebd8d40cd9e095760e29acf`，OCI `sha256:64d1fefdfc73838d6cd926446fb94ebcff84986bafa1fc897e2f8e18d6c228be`，TAR SHA-256 `073f3dbcb200bf813e9e6b10f8a76b128caf8a432e92f1d6420bffe553511b76`
- BFF config/image `sha256:8850f2ee3756dcc0b44169c30b8d21558377d566e77c96c767a837e7f6f88c02`，OCI `sha256:4e8e52c5f238b345e214e63d4b96d37604d7ee907149c2dcc7d3b73173f0f40e`，TAR SHA-256 `2ad4bac64ae4d84c621f0b61b6cd5735cb37d086a8d8fa09db4defa4d7bc6af5`

### 本轮实际修复

- 历史接口隐藏超过 72 小时的已结算/已明确未收费终态；unknown、pending、billing_unknown 和恢复中的任务继续返回。
- 首次读取某 owner 历史时自动触发有限批次清理，并为该 owner 建立 6 小时重复维护；每次删除前重新 GET 权威 receipt，绝不使用恒真 confirm。
- 删除仅限已过期、receipt 终态匹配、无仍在保留期原片的 task/identity 展示记录；quote、dispatch claim、receipt、usage/dedup 和财务证据保留。
- 清理结果记录 deleted/failed/bytes；重复执行安全，删除失败不阻塞历史读取。
- 视频页面不显示图片 72 小时文案。

### 受控部署方案

部署前以当前生产三组件和开关为基线，校验新 manifest/TAR/config digest；先灰度或维护窗口切换三组件，再做只读健康、历史接口和原片下载检查。确认图片/视频开关、商品、余额、usage/dedup、receipt 与历史任务指纹不变后，才允许恢复原图片状态。生产执行 owner-scoped 清理只会由客户历史读取触发，首次运行按批次处理并记录统计；不做全库扫描、不删除未决任务、不改视频策略。

## 最终公平清理候选

- 最新运行源码：`d1b87b3f80c0a42e7b7905c153e5532f38182a23`
- Candidate Run：`38883814258`，Candidate/Acceptance `PASS`，状态 `CANDIDATE_READY_NOT_DEPLOYED`
- CI：`38881494843` PASS；Security：`38881494777` PASS
- 完整 Artifact：`12039074579`；小证据 Artifact：`12039573346`；预计 2026-10-30 到期
- Manifest SHA-256：`e1774699fbee677f9b6df8bf99c84bc5ba6b47263ffd31424571602f575a86f4`
- Core config/image `sha256:e0c546c87ac43656bef14341176ffabf4870cff95d1c3c8110f64ab8108b4174`，OCI `sha256:285924aa048bde1b9d25a456a873640cd6570fc4b27deac82bcfc9fde0197387`，TAR SHA-256 `a3be77732ca6c32d4b966aaf8bda6acad084148f99f00b0a136929f6b80e77cb`
- Bridge config/image `sha256:4a00c84a893aac260178d013f9641dc3e8d28e73f90d98354defacf19690f05e`，OCI `sha256:0f8cd5efdd7955a599c92e6588ed8fe0e42f5fa0fe717a4f357ca28e9fb8b0f9`，TAR SHA-256 `34709d490ce8d87fff70d4f3133059256acd88d61c3ca6543c36aa19c71abf96`
- BFF config/image `sha256:564d2207099d8c2d3c21882b8c91342f49313a350e357e1e3f5591dd185e27eb`，OCI `sha256:489debb67b625d69b6043f6eabb28f7d09db944a694c92fe91b9cac8179cac78`，TAR SHA-256 `110c95c954b501c34f9feb066ef4e6f0b16871047aaf0c476f9a458ad5d151db`

公平批次采用 owner-scoped 持久 cursor，每轮最多检查 batchSize 条，前面的未到期/未决任务不会永久挡住后续任务。历史 GET 是唯一自动触发点；请求期间复用 in-flight promise，下一次请求重新认证，不保存 15 分钟 TTL 之外的 sessionProof。没有跨用户后台定时器；不活跃 owner 的展示 journal 可能在下一次合法访问前保留。图片原片的全局 6 小时清理不变。
