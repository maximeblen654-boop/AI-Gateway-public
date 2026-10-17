# AI-Gateway 作品档案馆方案 B 交接（2026-10-17）

## 阶段状态

当前阶段：`IMPLEMENTATION_READY_FOR_REVIEW_NOT_DEPLOYED`

本阶段基线：`0e68d4410a02b0c7dfb970c6e4072c3d2529186b`
实施基线提交：`fe1c6137d74d5fa2ff55bd0840d4d3f4937aced6`
桌面布局修正提交：`e0cfe38c9`
分支：`codex/media-paid-controls`

用户已选择 Plan B「作品档案馆」方向。本阶段只做正式 Vue 实现、隔离前后端联调、浏览器验收和候选准备；不部署生产、不执行真实供应商付费请求、不改商品、价格、mapping、资金、权限或开关。

## 已实施范围

- 文生图、图生图和视频共用作品档案馆的创建工作区：桌面采用作品区 + 整宽对话式输入卡，保留模型胶囊、底部规格和服务端报价/确认链路；手机沿用双列作品和移动规格布局。
- 任务历史保持独立浏览面：混合图片/视频列表、全部/仅图片/仅视频筛选、桌面横向浏览、手机双列；历史页不渲染无关创作输入框，使用“新建创作”菜单分别进入文生图、图生图或视频。
- 矮屏桌面（1366×650）通过紧凑编辑卡保留提示词、规格和主按钮在首屏；不裁剪必要参数。
- 桌面 Plan B 模型状态弹层改为向下展开，避免 passive_status 详情展开后覆盖状态按钮；状态数据仍来自现有 passive_status，暂无数据/过期/样本不足保持中性。
- 既有混合历史、失败任务显示/隐藏、任务详情、原片预览/下载、恢复、报价冻结、资金与幂等逻辑保持复用。

## 代码与测试证据

变更文件：

- `frontend/src/components/video/StudioMediaPanel.vue`
- `frontend/src/styles/studio-workspace.css`
- `frontend/tests/studio-workspace/workspace.spec.ts`

本地证据：

- `StudioMediaPanel.spec.ts`：62/62 PASS。
- Playwright `workspace.spec.ts`：24/24 PASS，覆盖混合历史、筛选、无静默生成、模型状态、1440×900、1366×768、1366×650、390×844、浅色/深色和失败任务显示/隐藏。
- `node --test studio/bff/image-binding.test.mjs studio/bff/plan-a-isolation.test.mjs studio/bff/image-server.test.mjs`：30/30 PASS。
- `pnpm run typecheck`：PASS。
- 受影响 Vue/TypeScript 测试文件 ESLint：PASS。

## 真实隔离联调

使用既有隔离 Core/Bridge/BFF、模拟上游、同源代理和真实管理员会话完成非付费合同核对：

- 真实 session exchange 成功。
- 实际 GET `/studio-v2/api/image/tasks`、`/studio-v2/api/image/readiness`、`/studio-v2/api/video/operations` 成功返回。
- 全部/图片/视频筛选产生对应 GET；历史切换未发送任务 POST。
- 真实隔离栈当前没有可展示的种子历史/商品，因此非空作品卡、详情、结果下载和模拟报价/提交由 fixture 浏览器回归与既有隔离合同证据覆盖；不能把空历史真实截图当作完整付费端到端成功。
- 真实截图：`D:/AI-Gateway-native-media-20261012/evidence/workspace-real-1440.png`、`workspace-real-390.png`。

## 设计截图

正式 Vue fixture 截图由 Playwright 输出到：
`frontend/test-results/workspace-Plan-B-creation-and-archive-surfaces-*`。

其中包含 text/edit/video/history 的 1440、1366×768、1366×650、390px 版本；这些是隔离 fixture 视觉证据，不是生产截图。

## 候选

GitHub Actions 候选 Run：`39036724267`（PASS，非部署）。
CI：`39036689973`（PASS）；Security：`39036689972`（PASS）。
运行源码与构建/验收脚本 SHA：`fe1c6137d74d5fa2ff55bd0840d4d3f4937aced6`。
完整候选 Artifact：`12102379261`，名称 `native-media-candidate-fe1c6137d74d5fa2ff55bd0840d4d3f4937aced6`，大小 254,198,661 bytes。小证据 Artifact：`12102718329`，大小 21,885,094 bytes。

三组件均为本次候选实际构建（`paid-controls` 运行方式未复用旧 sidecar）：

- Core source SHA `fe1c6137...`，image/config digest `sha256:283a77ee3dd0837dff22fa2e534fb5d0d7c8e07d984becf949f2ab180e24fc62`，OCI manifest `sha256:2719e1803ab8ba589f9ba0a26d8db86f8f529ce7c8e1ae3cba6a65a01146ddfa`，TAR SHA-256 `5083b8a857a55682a2f3eed45ecce9450fe538908b4feba1f9a390551de6c68f`。
- Bridge source SHA `fe1c6137...`，image/config digest `sha256:a048b161c927be8be7f50006de670386ff02ed2b485527672d04de6b9458b747`，OCI manifest `sha256:484337feebe359080a8f68555038c31782c7fe4e9bb5e3d041fa0f7f73a99544`，TAR SHA-256 `7fd4bbecdbf257e5cde778520132e2d2b0673a6f58186676835c6bb45de84031`。
- BFF source SHA `fe1c6137...`，image/config digest `sha256:4ee8d2f0e94ae84e307e2e8c2033997c2ab6420a83cedecb138402d321b4e656`，OCI manifest `sha256:ca8e50daf7548a928ba572352680633d157e9239ecd55d8d102db5f17346ceca`，TAR SHA-256 `974d6a0d6d29d56b4408d94f5157cf026332ee637d79aea06e7cb34dcac88f6b`。

候选 manifest 文件 SHA-256：`3dade8305a66f4a8d8d56afcd253f031dd021fc4891643f70bb9799ffc28f080`；小证据 ZIP SHA-256：`000515479d04822bdde971f52c54e34b39c27298b98ea8f9f2871f1c0f1184ff`。runtime-files 校验与完整 manifest 均已归档；本地不重复下载完整 254 MB 包。候选状态为 `CANDIDATE_READY_NOT_DEPLOYED`，`production_action=false`，候选验收环境的 paid flags 均为 false。候选不等同于生产部署。

## 方案 B 桌面布局修正（待用户复核）

上一候选的桌面 composer 曾被排到作品右侧。本次 `e0cfe38c9` 已按设计包改为：作品展示在上方，整宽对话式 composer 在下方；主作品+两张辅助作品保留，1366×650 仍保留提示词、规格和主按钮。手机、历史页、模型状态和业务 API 合同未改动。

本次修正尚未进入候选镜像。用户确认截图后，必须以 `e0cfe38c9` 为运行源码重新构建并验收新的候选；旧 `fe1c6137...` 候选不能冒充本次布局修正版。

## 后续唯一动作

候选 PASS 后，交给用户审核并等待单独生产部署授权。生产部署前重新核对现网版本、业务保护指纹、回退资产和 managed-v1；未获新授权不得切换生产。

Constraints 原文保持不变。

