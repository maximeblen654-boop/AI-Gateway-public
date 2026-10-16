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
