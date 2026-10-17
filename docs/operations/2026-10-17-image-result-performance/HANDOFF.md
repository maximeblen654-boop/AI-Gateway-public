# 图片历史结果加载性能修复：候选交接

状态：CANDIDATE_PREPARATION

## 当前生产只读核对

- 公开域名 https://laifufu.top/studio/ 与 /health 返回 200；三次采样页面 0.93–2.82 秒、健康端点 0.60–1.14 秒，均由 Caddy/Cloudflare 动态转发。
- 生产三组件实际运行 native-candidate-{core,bridge,bff}:784d12c3257d7ce40d106ad7991abe6d40c74555，均 healthy；BFF 使用 managed-v1、私有图片/素材挂载。
- BFF/Bridge 近24小时容器日志没有请求级任务耗时字段，不能从日志伪造 Core、原片传输或解码耗时。性能根因以源码链路和隔离计数回归为准。
- 当前用户描述的 d1b87b3f 是旧基线；本次只读核对确认现网是 784d12c。本轮未部署新代码。

## 已确认根因

1. StudioMediaPanel.vue 在选择任务和恢复页面时无条件调用 studioTask()；已完成/已结算任务因此再次触发 BFF recover()，并可能继续向 Core 查询 receipt/result。
2. BFF 原片接口设置 private, no-store，已保存的 4K 原片重复打开会再次传输完整字节。
3. readiness 失败时前端把 enabled=false 直接渲染为“当前生成服务未开放”，把状态暂不可用和真实关闭混为一谈。
4. readiness 读取不应触发 /keys/studio-access；目录/创建入口仍保留原有凭据准备。

## 本次源码修复

候选源码：62374582ab346e29deebdaf48a38fd0e52f5c110

- 已完成/部分完成且本地结果齐全的任务：历史卡片打开和页面恢复不再自动调用 Core；BFF 对本地结果完整的终态直接返回，缺结果才走恢复。
- unknown、queued、processing、billing_pending、reserve_pending、recovery_blocked 继续保留原恢复/查询；失败和已释放任务不通过本地短路绕过权威 receipt。
- 结果元数据使用内容 SHA-256 ETag，原片响应改为 private, max-age=60, must-revalidate，支持 If-None-Match 304；不变更下载 URL、原始画质、权限或保留期限。
- readiness 分为 enabled/disabled/unknown；请求失败时只显示“暂不可用”通知，不误报“未开放”。生成按钮仍 fail-closed。
- 加入已保存结果加载中的轻量提示，不改变任务卡片布局。

## 验证

- 前端 StudioMediaPanel.spec.ts：61 tests PASS。
- BFF image-binding.test.mjs + image-result-store.test.mjs：29 tests PASS。
- 前端 typecheck：PASS。
- 受影响 ESLint：PASS。
- BFF 三个模块 node --check：PASS。
- 新增回归：完成任务再次打开不查询 Core；结果 ETag/私有缓存可返回 304；缺失结果仍允许恢复。

## 部署边界

本轮仅提交源码、隔离测试和候选准备。尚未构建、部署或改变生产数据、开关、商品、账务、任务及原片。候选构建和完整镜像身份待 GitHub Actions 完成后补录.


## 候选验收结果

- 运行源码：`75f8bdc2b545c5edde552e9b896aef4f9e18028e`
- Candidate Run：`38938645575`，PASS；CI/Security 沿既有工作流完成。
- 完整候选 Artifact：`12063196736`，归档 ZIP SHA-256：`39d005c5d8af921d4ca7ba1c8e9dc5463d314970ccaf87d44c3ffeb8b66d2b87`。
- 小证据 Artifact：`12063650738`，归档 ZIP SHA-256：`457413df61249df1d3e0743df51fb550e8c410aae04691b61a01a98d8d738ee4`。
- Core manifest/config：`aa9fdbfc510b4756149b100461b5288ba5d6484104054cb45ae3efb4069ea729` / `ad3a229242e274dd02f48c6659f73a4cd03ac524998a35ea433af9094cc69302`。
- Bridge manifest/config：`088f0181295715dbc794bdadf1f03944ae6fb8dcf2206a5dff59a23f335e81b1` / `38b11e836ee2960071e7c62b27724741ddc737356904f50c57cb464bd4b5903b`。
- BFF manifest/config：`d61df4f3f7c45439947b578d20c68886eb10a341cd1495698204eea67d44f710` / `d1093e3c997e2f7ca7a591aec14027bc5dc907028aac17085ae58f3fc05c6ea0`。
- 三组件运行源码来源均为本次 `75f8bdc2` 候选；本轮没有复用旧组件身份。
- 隔离验收：图片文生图、参考图编辑、单视频均通过；104 笔资金/幂等场景通过（502 16、成功24、部分12、拒绝12、断线12、超时12、迟到8、重复8）。

候选未部署，生产仍为 `784d12c3257d7ce40d106ad7991abe6d40c74555`。生产部署需另行授权。

## 生产部署记录（2026-10-17）

状态：`DEPLOYED`

- 用户授权已执行固定候选 `75f8bdc2b545c5edde552e9b896aef4f9e18028e`；未重建镜像。完整 Artifact `12063196736` ZIP SHA-256 为 `39d005c5d8af921d4ca7ba1c8e9dc5463d314970ccaf87d44c3ffeb8b66d2b87`。生产主机上的 manifest SHA-256 为 `e413ecbb222f7c8ab671f77183cc9b756b3df05ce2ba838b2f142ca4e140ef77`。
- 受控切换时间：北京时间约 `2026-10-17 16:14:21` 至 `16:14:49`，约 28 秒。Core 先重建并 healthy，再重建 Bridge/BFF；未重启 PostgreSQL/Redis，未迁移数据库。
- 实际运行镜像：Core `native-candidate-core:75f8bdc2b545c5edde552e9b896aef4f9e18028e`，OCI manifest `sha256:17f8f06b1083595ac892b850b77528df9a01b928b5c7b666cd2b986c544950c7`，config `sha256:ad3a229242e274dd02f48c6659f73a4cd03ac524998a35ea433af9094cc69302`；Bridge OCI `sha256:f53d61987a98c2fa79d22cebceb7b487104e30bbe8a124c0667e30569f7b200d`，config `sha256:38b11e836ee2960071e7c62b27724741ddc737356904f50c57cb464bd4b5903b`；BFF OCI `sha256:3c7f6ba4448e824a22e12cf0b97f6600bbdb35f6360b17ef4e9f76b8f3a8a354`，config `sha256:d1093e3c997e2f7ca7a591aec14027bc5dc907028aac17085ae58f3fc05c6ea0`。三组件 OCI/config 与 manifest/TAR 逐项一致。
- 三组件均 healthy。Bridge/BFF 通过 `container:9af2de99af73571e1d3a5030a9b3c1a268858f90f35581d01e2bbdccabd5faf0` 附着新 Core network namespace；原 Compose base、PostgreSQL、Redis、持久化挂载及 Caddy 未改动。BFF 仍挂载 `/var/lib/ai-gateway/studio-v2/{assets,images,videos}`。
- `https://laifufu.top/health`、`/studio/`、`/video-studio` 均 HTTP 200。未带会话的两个 readiness 路由均按合同返回 401（`image_session_required` / `video_session_required`），没有把未认证 401 当作关闭状态。生产数据库只读设置 `studio_paid_control_image_v1.enabled=true`；`STUDIO_PAID_CONTROL_MODE=managed-v1`、legacy 图片提交开关 false、视频提交开关 false，视频保持关闭。
- 启动日志未出现迁移或启动错误；商品、价格、mapping、余额、usage/dedup、历史任务和原片未写入或改动。没有发送真实供应商请求。
- 发布守卫基线与回退证据：`/home/ubuntu/services/ai-gateway/deploy-history-performance-75f8-20261017/`，含 `release-baseline.json`、`compose.override.before.json`、`compose.override.75f8.json`、固定 manifest、三份 TAR、候选清单及切换脚本。未发生回退。
- 本次使用的已验收隔离证据继续有效：完成图片短路、缺失结果恢复、私有 ETag/304、过期拒绝、权限隔离和 unknown/billing_pending 保护由候选测试覆盖；本轮生产未触发任何任务恢复或付费请求。浏览器 CUA 连接在本次执行中返回 `helper_unknown_error`，因此无法取得新的已登录桌面/手机截图，也未声称已完成需管理员会话的交互式 readiness 与 任务卡片回归；公网页面和服务身份已完成只读核验。
- 部署前临时 Artifact 下载、解压和脚本已清理；生产部署目录中的唯一候选 TAR、manifest 和回退材料保留。
