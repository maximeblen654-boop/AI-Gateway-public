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

