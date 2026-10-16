# Studio 原片结果卡片视觉修订

状态：`IMPLEMENTED_NOT_DEPLOYED`

## 目标

针对真实任务结果页：

- 让“下载原片”成为清晰的主操作，降低用户寻找成本。
- 给图片两侧留白加入克制的 INS 风 editorial 背景，保留原图比例、完整展示和现有任务卡片结构。
- 深色模式与 390px 手机布局保持可用。

## 实现

- `frontend/src/components/video/StudioMediaPanel.vue`
  - 新增结果舞台容器和明确的 `.studio-download` 下载入口。
  - 保留原 `studioResultUrl(active, index)`、`download` 属性、`data-testid="studio-download"` 和任务身份。
- `frontend/src/styles/studio-workspace.css`
  - 新增暖桃、薄荷、淡紫低对比渐变背景。
  - 下载入口使用现有 `--sw-accent` 体系，支持 hover、focus-visible、active、深色和手机状态。

## 前后端联调边界

本次只改结果卡片展示层。下载仍请求现有 `GET /studio-v2/api/image/tasks/:task_id/results/:index` 路径，未改变任务、原片存储、过期清理、结算或权限合同。已有 `StudioMediaPanel` 60 项回归和 `vue-tsc` 已通过。

## 验证

- `pnpm vitest run src/components/video/__tests__/StudioMediaPanel.spec.ts`：60/60 PASS
- `pnpm run typecheck`：PASS
- 本地提交：`e4297ed03239ca5c4b98917ae96861730ec2eaa4`
- 未部署生产，未发送真实供应商请求。

本候选待通过既有 GitHub Actions、三组件隔离验收和受控生产部署流程后才可上线。

## 生产部署结果

状态：`DEPLOYED`

- 生产运行源码：`784d12c3257d7ce40d106ad7991abe6d40c74555`。
- Candidate Run：`38915485250`，完整隔离验收 PASS；Artifact：`12053960224`，小证据 Artifact：`12052709301`。
- 三组件 OCI 身份：Core `sha256:1d6e581e5959efb71ccf7e2c983e7a0977e40d02afdd9be8f822e312f3bac718`；Bridge `sha256:380eb805c15526fbe7bad191b84276792d77edf3b47ff657f6d3f2034786c405`；BFF `sha256:abb6bb06ff37934683799c6d406605cf92488291fffba2927cd30817bad5da9c`。
- VPS TAR SHA-256：Core `ce2beb3b467f6d8c480a38748b242f2847e35a8f1d9f9ac0c317dabc4828cba0`；Bridge `ccbc06f4b5d668807d21b3cd814809c16c9ac7fa70b9c2c027ca5d1cf0756c1b`；BFF `429f5dcf8487385a992103a5e18b80b6c63b1722d4def93fa3dcd84d2d7e608a`。
- 三组件健康，Bridge/BFF 附着新 Core network namespace；公网 `/health`、`/studio/`、`/video-studio` 均 HTTP 200。生产图片/视频开关、商品、售价、mapping、账务和历史任务未改动。
- 结果卡片 UI 已上线：下载原片按钮使用 `.studio-download`，原请求仍为 `GET /studio-v2/api/image/tasks/:task_id/results/:index`；图片两侧使用轻量 INS 风渐变背景，深色和手机规则保留。
- 未发送真实供应商请求，未触发生产清理或业务写入。回退备份：`/home/ubuntu/services/ai-gateway/deploy-result-card-e429-20261016/`。
- 部署切换约 39 秒；临时候选压缩包已删除，manifest/TAR 校验与回退资产保留。

GPT 可从本文件读取完整设计、联调边界和部署身份。
