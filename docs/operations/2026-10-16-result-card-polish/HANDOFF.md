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
