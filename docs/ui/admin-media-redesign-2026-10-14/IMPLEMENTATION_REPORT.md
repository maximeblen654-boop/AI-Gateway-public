# 管理员媒体工作台：正式组件实现与隔离联调

状态：IMPLEMENTATION_IN_PROGRESS，尚未部署。本文覆盖 PR #1 的条件实现，不替代正式 Handoff。

## 实现范围

- 沿用 MediaWorkbenchView / useMediaWorkbench 的 Account、商品、草稿与发布状态，保留五步流程。
- 复用 pricingMatrix、decimalText、costCalculator 和后端 API；prototype.js 未导入业务代码。
- 白色/深色工作面、简化模型列表和五步层级；每行成本按钮打开现有计算器。桌面抽屉避让价格表，手机底部弹层保留焦点，Escape 返回触发位置。
- 图片明确 0 元仍可预览；视频 0 元显示具体合同限制，不呈现为可报价免费商品，未扩大后端免费视频能力。
- 请求预览明确最多 64 条、属于抽样；规格选择及价格表仍来自完整 capabilities / combination_rules / pricing_rules。
- 后端执行、发布、金额、模型映射及结算实现未修改。成本记忆继续仅按管理员、Account、商品和稳定规格键保存在浏览器。

## 当前验证

- 100 项定向单元测试通过；正式 Vue 的 17 项浏览器流程通过。
- 截图检查后补充抽屉宽度、编辑价格时保持展开、键盘焦点保护；成本抽屉 1440/390 × 浅/深色连续三轮共 12 项通过。
- 真实隔离后端验收由现有 native-media-candidate.yml 的 admin-ui-review 入口执行。只构建一次性 Core 测试镜像，固定复用 b2 Bridge/BFF，不导出运行候选或部署。
- 真实 API、PostgreSQL、模拟上游与冻结报价依赖测试结果待云端运行，不能把此前 Axios fixture 的通过当成联调完成。

最终源码、Run、证据路径及截图将在本轮实际结果产生后补齐。
