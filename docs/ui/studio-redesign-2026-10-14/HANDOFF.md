# AI-Gateway 工程阶段交接 · 2026-10-14

这是 Codex 本阶段执行记录，供 ChatGPT 接续；不替代或改写项目根目录的正式 `AI-Gateway-Handoff.md` / Constraints。

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
