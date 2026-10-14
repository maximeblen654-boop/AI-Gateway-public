# 可直接交给 ChatGPT / Codex 的正式实现复审提示词

请复审 AI-Gateway 管理员媒体工作台 PR #1 的正式 Vue 实现。仓库 maximeblen654-boop/AI-Gateway-public，分支 codex/admin-media-design-review。前次条件审核 Review ID 为 5513583921。

先读本目录 IMPLEMENTATION_REPORT.md，再看 INTEGRATION_REVIEW.md 和 implementation-evidence 中的真实结果。README 的正式组件截图与旧原型截图已经区分；不能把旧 prototype PASS 或 Axios fixture PASS 当成后端联调 PASS。

本轮复用既有 Vue/composable、pricingMatrix、金额工具、成本计算器及 API，没有导入 prototype.js 作为业务状态，也没有改后端业务实现。后端、Studio、镜像配方与依赖的相同来源由 reuse-proof.json 核对。请直接审查源码与实证，不只审截图。

重点检查：
1. 视频 0 元：正式 UI 不再把它描述成可报价的免费视频；真实 BFF 目录排除合成零价视频并保留同 Account 的正价商品。免费图片仍可完成真实服务端报价与一次原生 usage。没有扩大后端免费视频能力。
2. 冻结报价：仅改草稿时保留 Published、冻结单价、规格、数量和执行计划；发布版本、Account mapping 或路由发生变化时，提交必须在上游调用和扣费前拒绝。核对 quote-drift 报告以及 contract-cross-check.json，不用“报价对象未变”代替实际提交/请求/结算证据。
3. 64 条编译预览是抽样，不能作为完整规格或售价覆盖依据。检查完整 capabilities/combination_rules/pricing_rules、72 行矩阵用例、真实多规格商品的保存重读及超出预览顺序的实际请求。
4. 管理员页面选择 → 保存请求 → PostgreSQL 重读 → 服务端发布校验 → 冻结报价 → 模拟上游参数，分辨率、比例、数量和售价是否一致；没有预填 size_mappings，没有浏览器 API mock 或 Vite 代理。
5. Account 级发布与销售分离、二次确认、多商品草稿、显式移除保护和未保存修改是否保留；成本记忆仍只在当前浏览器按管理员/Account/商品/稳定规格键隔离，不进入保存、发布、客户或结算合同。
6. 正式 Vue 桌面 1440px / 手机 390px、浅深色、抽屉避让/焦点/滚动与返回操作。图片、编辑、单视频的结果下载、刷新查询是否不增加生成或原生结算。

输出具体源码位置、证据和缺口，区分实证缺陷与未测试假设。此次最多认可实现可进入后续候选准备，不批准生产部署、生产商品发布、启售或真实付费请求。不要把云端临时隔离栈结束后的地址称为当前可访问入口，也不要把本轮未导出的测试镜像称作生产候选。
