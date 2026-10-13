# AI-Gateway 工程阶段交接 · 2026-10-14

这是 Codex 本阶段执行记录，供 ChatGPT 接续；不替代或改写项目根目录的正式 `AI-Gateway-Handoff.md` / Constraints。

**当前进度：用户已选择 C「作品桌」，完整实现及真实隔离前后端联调已完成。下方阶段一是选版历史；当前结果以“阶段二”和末尾验收表为准。未部署生产、未构建新 Docker 候选。**

## 当前目标与版本边界

用户明确要求重新设计**客户生成工作台**。参考用户提供的聊天式创作截图：比例点选、悬浮模型选择与紫色上浮提示、左侧文生图/图生图/单视频/任务历史。先交几版实际画面比较，不扩大到无限画布、模板平台或多视频。用户将简短主文案交由 Codex 决定，本阶段使用“让想法有画面。”

- 开发分支：`codex/studio-native-media`；本阶段开始 HEAD：`4381fdc8d2238ae0f2e0f974bf7b7f279ab97bff`。
- 该父提交已经包含管理员“← 返回模型列表”和顶部 Account 发布入口改善；其 CI 38458650075 / Security 38458650038 通过。保留这些未部署修改。
- 生产版本按用户最新确认仍为 `b2fcdac93afa6ae194ee81801a9b37813f8f39eb`。本阶段没有连接生产重新核查，没有部署。
- 本阶段源码与本文、设计目录位于同一提交；以本文固定 GitHub commit URL 为准，不把父提交或生产 SHA 当成当前修改。

## 已完成：三版整页方向稿

文件：`docs/ui/studio-redesign-2026-10-14/`。入口 `style-explorer.html` 为可离线比较页；`a.html` / `b.html` / `c.html` 为三份独立首屏。

| 方向 | 主要结构与取舍 |
| --- | --- |
| A 轻聊（推荐） | 完整左侧栏 + 居中输入；模型/比例浮在输入框上方。最接近日常聊天习惯，主动作不分散。 |
| B 对照 | 左边新输入，右边已有作品与缩略图；适合边看结果边构思，但窄屏必须折叠预览。 |
| C 作品桌 | 窄导航 + 历史作品网格 + 底部输入条；更适合经常回看任务的用户，首次使用需空状态。 |

北极星：让客户只关注描述、素材和结果，不必理解 Account、内部 ID 或执行协议。三版保留参考的柔和浅底和悬浮控件关系，不复制参考中的积分、营销价格、社群、无限画布或供应商承诺。正文使用 Microsoft YaHei UI / Microsoft YaHei / Segoe UI；主要操作 14–16px。三版使用同一份合成提示词、模型名、规格和历史内容；没有采用生产数据。

这是 oil-ui 0.22.2 的**方向探索阶段**，不是已接通后端的新工作台。所有截图为 1440×900 的 Chromium 渲染，均已人工查看，未见重叠/裁切/水平溢出；未派独立审查、未打评分。未做移动端/深色/完整交互验收。比较页自身可切换查看，候选页为静态。

紫色双箭头当前保留视觉位置；选版后拟做首次出现小幅上浮两次（4px，合计不超过 1.2s），不无限循环催促；点击模型时浮层向上展开约 200ms；比例切换即时生效并用短过渡反馈。支持 prefers-reduced-motion。以上是**后续动效计划，未实现**。

文案做了减法：不用长口号、供应商“无限制”宣称和协议说明；首屏主文案统一“让想法有画面。”，提交区域明确“先看报价，再确认生成”。数量、分辨率、比例和价格确认不能被装饰隐藏。

## 已完成：客户数量输入缺口检查与最小修复

现象属实，但“能手输任意数字”不等于服务器允许无限生成。

1. `StudioMediaPanel.vue` 原为 `type=number`，只有 HTML min/max；报价按钮及 quote() 没有对应数量保护。隔离回归输入 0、11、1000000、1.5、空值，修复前 5 个用例均失败（按钮仍可点）。
2. 改为按当前已发布 offer 的 `spec.count` 生成有限选项，只接受 1～10 内的合法整数范围。旧商品范围 1～3 仍只显示 1～3，不扩大已发布可售数量。异常目录范围停止报价，不悄悄猜值。
3. 报价按钮禁用与 quote() 内部 guard 都检查合法数量；即使人为绕过按钮 disabled，也不会发送非法 quote。没有把无效数量强行改成 10 或修改商品配置。
4. 视频仍无图片数量选择器，现有请求/任务合同保持单条。
5. Core 实际链路为 `StudioImageRuntime.Issue` → `Service.ResolvePublishedImageOffer` → `NormalizeImageSpec`（拒绝 Count < 1 / > 10）和 `Offer.Matches`（商品范围），再到 `PriceForQuantity`（再次拒绝越界，冻结精确金额）。BFF `image-binding.mjs` 校验 quote 响应整数及 1～10；前端 `studioTaskView` 同样拒绝无效已返回任务数量。这不是仅靠浏览器保护。

运行源码仅修改：
- `frontend/src/components/video/StudioMediaPanel.vue`
- `frontend/src/components/video/__tests__/StudioMediaPanel.spec.ts`

未修改 Core/BFF/Bridge、模型映射、规格编译、价格、任务存储或结算。

## 本阶段实测

- 修复前：新增非法数量用例 **5/5 失败**，复现前端缺口。
- 修复后：`StudioMediaPanel.spec.ts` **35/35 PASS**，含 9 个数量场景及原上传、partial、历史恢复、过期报价、未知任务不重发等回归。最终强制绕过 disabled 的版本也通过。
- 上述两个变更文件 ESLint：PASS。
- Core：`go test ./internal/mediaworkbench -run 'TestPublishedImageRuntimeContract|TestPriceForQuantityPreservesExactScale' -count=1 -p=1`：PASS，覆盖 count=0/11 拒绝和原报价规则。使用本地隔离测试，不连接生产。
- 类型检查交给同提交现有 GitHub CI；本机此前完整 vue-tsc 因内存不足失败，此轮未重跑大型本地检查，不声称本机全量类型检查通过。
- 三张最终截图均已查看，文案已更新；设计方向没有业务接口请求，CSP 禁止网络连接。
- 本阶段尚未进行新 UI 与 Core/Bridge/BFF 的完整集成，不能拿方向截图当集成验收。

## 下一阶段接续

用户选定整体方向后，在现有 Vue 客户工作台中实现，而不是另建一套任务/账本。复用已存在的目录、quote、prepare、generate、history、refresh、original 及会话/归属权限。文生图/图生图是同一 image 业务的输入方式；不为了导航分成两份商品。参考图是否支持及必填取自已售 offer，模型只从现有授权目录读取，不按名称猜协议。

图片数量显示当前商品允许范围（系统上限 10），视频固定一条；后台单请求上限与购买数量继续分离。必须完整承接 completed、partial、unknown、billing_pending、失败、额度不足和销售关闭；报价总额与实际结算分开，未知结果只查询原任务。历史摘要不暴露内部 media UUID；原始任务 ID 可保留诊断详情，不占日常主界面。

下一步实现选定方向的三种输入模式、模型/比例浮层、图生图上传、历史详情、报价确认、进度与成品下载，以及移动端和深色主题。此时再进行真实隔离后端集成与相称测试。不因设计探索重复适配器、重新定价或重建媒体平台。

本阶段未上传生产、未重启、未改生产商品或开关、未发布/启售、未发真实供应商/实付请求；正式 Handoff 和 Constraints 保持原状。没有构建 Docker 候选。

## 阶段二：C「作品桌」实现与当前验收（2026-10-14）

用户选定 `03 C · 作品桌`，继续实现完整客户工作台。新左上角不使用上游星星；初稿双画幅被用户指出过于单调，已改为暖铜色折光 G 标记。主文案为“让想法有画面。”；无历史记录时展示可直接创作的空状态，不用假作品填充真实用户页面。

- 左侧文生图 / 图生图 / 单视频 / 任务历史；保留站内身份和原路由 `/video-studio`。
- 主按钮依用户意见改为“开始生成”；现有服务端 quote/prepare 之后展示本次数量与金额确认框，确认才调用生成。没有更改报价或结算合同。
- 文生图无附件入口；图生图/支持素材的视频用圆形回形针，复用私有上传、粘贴和拖拽。模型与参考图可用性取现有授权目录，不根据名字猜协议。
- 有限数量选择器只展示已售商品允许的 1～10 子集；视频始终一条。保留上阶段前后端越界证据。
- 最近作品与完整历史入口、原片下载、partial 原报价与实际结算、未知任务只查询；历史 task_id 收入详情，不把内部 media UUID 当模型名展示。
- 近期作品完整构图预览，手机近期显示两项并提供“全部任务”入口；浅/深主题、键盘焦点、减少动态偏好已处理。
- 控件动效：模型提示轻微上浮两次、选择浮层 180ms、作品卡片 2px 悬浮反馈；减少动态时禁用。

### 历史限制核对

本次没有改历史存储或删除策略。当前 `studio/bff/operation-journal.js::listForOwner` 默认返回最近 50 条视频任务；这是返回条数，不是删除 50 条之前的数据。`image-binding.mjs::history` 当前未限制图片历史条数。`image-result-store.mjs` 新图片原片默认 72 小时及总容量限制；历史记录不等于原片永久可下载，旧 metadata 有独立兼容语义，不能用前端计时器删除。视频原片存储不自动过期，容量不足时失败关闭。页面提醒及时下载，读取失败显示“原片暂不可用，可能已过期”，不猜测成功、不自动生成补图。

### 本地证据与隔离范围

- 受影响 Vue 组件/视图定向测试：45/45 PASS，另 API 合同 6/6 PASS，共 51 项（包含原上传、partial、恢复及数量测试）。
- 真实 Chromium 1440px / 390px 浏览器 UI 用例：9/9，连续三轮 PASS；它们采用局部前端 API fixture，仅证明 UI，不能证明后端结算。
- 独立静态视觉评审一轮 7/10：指出缩略图裁剪、手机第三项入口和焦点颜色问题；已做对应调整。折页图形进一步收敛为折光 G。该分数不冒充修改后的新评分。
- `frontend/tests/studio-workspace/main.ts` 仅供视觉交互预览；`live.ts` 挂载相同真实组件但没有任何 API mock，用于后端联调。
- 新增现有 `native-media-candidate.yml` 的 `accept-existing / studio-workspace` 场景：严格 GitHub-hosted、固定 b2fcdac 三镜像/摘要核验，Vite 提供当前前端，HTTP 透传到真实 Core/Bridge/BFF/PostgreSQL/Redis，仅上游是本地模拟器。前端与后端 SHA 分别记录，不把旧镜像标成新版本。最终真实联调 Run 38469785293 PASS，见末尾证据。
- 未改 backend/studio 运行代码、生产配置、正式 root Handoff 或 Constraints；没有部署、商品发布、启售或真实供应商请求。

预览：`http://127.0.0.1:4295/tests/studio-workspace/index.html`；空状态加 `?scenario=empty`，参考图点左侧“图生图”；深色加 `?theme=dark`。本地进程结束后地址不保证继续可访问。代码入口和截图保存在本目录与 `frontend/tests/studio-workspace/`。

### 阶段二最终运行证据

- 实际运行改动提交：`3efbc2951f07a5495b5dbbc0934ebe93edf66c39`。后续证据提交仅修正截图工具的 ESM 导入、补文档/截图和历史验证脚本，不改工作台运行代码。
- [真实隔离前后端联调 Run 38469785293](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38469785293)：PASS。证据 Artifact `11851047521`，约 210 KB，临时有效至 `2026-10-27T21:21:54Z`。摘要和截图已入本目录长期随 Git 保存。
- 当前前端与验收脚本 SHA 同为上述 3ef；后端复用已验收 b2fcdac Core/Bridge/BFF 精确镜像，没有 docker build，没有重新导出 TAR。没有把 b2 镜像标为 3ef 镜像。
- 浏览器正常登录隔离 Core，由当前真实 Vue 页面访问原 API。`live.ts` 无 Axios/fetch 拦截；只有上游模拟器，未使用生产资料。已核对三组件健康、镜像身份及共享 Core 网络命名空间。

| 场景 | 请求数 / 交付 | 合成冻结价 / 原生扣费 | usage 增量 | 刷新、查询与重复下载 |
| --- | --- | --- | --- | --- |
| 文生图 | 3 个单图请求 / 3 张 | 2.10 / 2.10 CNY | 1 | 无新增请求或扣费；摘要一致 |
| 参考图编辑 | 2 个单图请求 / 2 张 | 1.40 / 1.40 CNY | 1 | 无新增请求或扣费；摘要一致 |
| 普通兼容单视频 | 1 次提交 / 1 条 | 2.00 / 2.00 CNY | 1 | 无新增请求或扣费；原片重复下载一致，浏览器实际播放通过 |

以上金额均为隔离 fixture。图片模拟器返回有效 1×1 PNG，因此后端验收截图是纯色块；咖啡海报截图来自独立 UI fixture，仅展示设计，不冒充供应商结果。真实后端没有在这轮再次逐供应商验收：Core/BFF/Bridge 运行代码未修改，复用已有同版本媒体执行证据。

- 图片原片与重复下载 SHA-256：`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`。
- 单视频原片与重复下载 SHA-256：`9738ac5e6756d120b3a6805420362e31390b3b4a26b604dcacac86c660f72299`。
- 合成历史策略检查：创建 51 条，原生 journal 默认返回 50 条且 `hasMore=true`；未返回的一条仍可按身份读取，另一用户得到 0 条。图片默认 72 小时，到期拒绝原片读取。测试无供应商请求，临时目录已清除。复现：`node tools/native-media-e2e/history-policy-check.mjs`。
- 受影响后端已有测试 8/8 PASS，覆盖 partial、旧回执、过期报价、未知结果恢复、不重复生成及结算。前端组件/API 51/51 PASS，ESLint PASS，9 项浏览器测试最终连续 3 轮全通过。
- 首次云端联调因 Vite 工作目录错误而样式编译失败（Run 38468297774），已修正启动目录；第二次和最终加强联调均通过。3ef 的 CI 前端 job 发现新截图脚本两处 CommonJS 导入不符合项目 Lint，已改为 ESM 并在本地重新执行全部新增前端文件 Lint；最终证据提交的 CI 单独列入交付结果，不将失败藏为通过。

### 设计与交付位置

桌面 1440px、手机 390px、浅色/深色、无历史、附件、partial 和金额确认均有真实 Chromium 截图，并逐张检查。作品完整构图使用 contain，手机最近两项有“全部任务”入口；主要输入框焦点收敛为棕色，紫色仅留给模型提示。一次独立静态评审 7/10，指出的问题已修正，未虚构第二轮评分。减掉上游宣传、积分、额外模板入口与重复协议说明，保留规格、数量、服务端金额和任务状态。

- [作品桌 · 桌面](screenshots/c-gallery-desktop.png) / [手机](screenshots/c-gallery-mobile.png)
- [无历史 · 桌面](screenshots/c-empty-desktop.png) / [手机](screenshots/c-empty-mobile.png)
- [附件 · 桌面](screenshots/c-edit-desktop.png) / [手机](screenshots/c-edit-mobile.png)
- [partial](screenshots/c-partial-desktop.png) / [金额确认](screenshots/c-generation-confirmation.png)
- [深色 · 桌面](screenshots/c-dark-desktop.png) / [手机](screenshots/c-dark-mobile.png)
- [真实后端文生图](screenshots/c-backend-image.png) / [编辑](screenshots/c-backend-edit.png) / [单视频](screenshots/c-backend-video-compatible.png)
- [联调摘要](evidence/real-backend-summary.json) / [历史策略](evidence/history-policy.json) / [本地测试](evidence/local-validation.json)

可复现预览：在 frontend 运行 `node node_modules/vite/bin/vite.js --config tests/studio-workspace/vite.config.ts`，打开 `http://127.0.0.1:4295/tests/studio-workspace/index.html`。截图：`node frontend/tests/studio-workspace/capture.mjs`。功能测试从 frontend 执行 `node node_modules/@playwright/test/cli.js test --config playwright.studio.config.ts`。预览仅为隔离 UI fixture；云端真实栈已结束，不能把 runner 地址当作仍可访问的环境。

本轮最终状态为**源码和隔离联调完成，未部署**。若后续批准准备运行候选，前端资源变化需要重建包含它的 Core；Bridge/BFF 运行源码没有变化，可以沿现有流程判断精确复用。不能拿本轮前端预览或旧 b2 镜像宣称新版工作台已上线。
