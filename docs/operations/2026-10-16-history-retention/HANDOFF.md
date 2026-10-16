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
