# 比例配置与模型被动状态：实现与联调说明

修订运行源码冻结为 `15da7cbbaefe4a3ea11fda6dfd983e030db44b4a`。本次仅非生产开发与隔离验收；最终候选状态以 HANDOFF/manifest 为准。

## 管理员比例

`MediaProductEditor.vue` 只给图片商品新增 1:4、4:1、1:8、8:1 快捷选项。`MediaTokensField.vue` 增加可聚焦的自定义输入、添加/移除、正整数格式提示、trim和去重；原逗号编辑继续写同一个 `capabilities.aspect_ratios`。不会自动给已有商品添加比例，不扩大视频能力，不修改价格。

定向测试覆盖添加、取消、重复、无效输入、恢复、图片/视频隔离与原有控件兼容。最终镜像验收脚本 `aspect-options.cjs` 通过真实 Vue 操作保存/重读/发布，仅在隔离数据库操作；验证未发布比例拒绝报价、已发布 3:5 文生图及编辑实际请求原样传参、下载摘要和一次原生结算。早期运行38779548609已完成此部分：configuration_pass和execution_pass均为true。未发布3:5报价409；隔离发布后文生图/编辑1K/3:5/1张均提交一次，报价与结算各0.70 CNY，usage和dedup各增1，原片摘要一致，刷新不重复提交/扣费。该轮在后续旧任务重新登录脚本前置断言失败，不能据此称整组候选PASS。

## 客户模型选择：用户选定 A

Oil UI 0.22.2 已调用；三方向见 DESIGN.md，用户明确选择 A“简洁标签”。正式组件为 `StudioModelPicker.vue`，沿用作品桌配色、尺寸与弹层；状态按钮支持鼠标、键盘聚焦和触屏详情。保留真实 offer_id 选择，调用既有重新报价逻辑，不自动生成、不自动切换渠道。

`studio_passive_status.go` 由现有授权目录构建器附加可选 `passive_status`，复用原生 ChannelMonitorV2Service/Repository，只查询当前原生 Key 的 Group、真实 Account 平台和 requested model。一次目录至多一次原生矩阵查询，750ms独立截止；错误降级中性，不阻止目录。

统计范围是平台＋Group＋requested model，不是 Account 健康。DTO只包含状态、范围、90分钟窗口、数据/计算时间和适用时的错误率；不输出凭据、请求量、原始错误或其他用户身份。native minimum_sample、完整覆盖和10分钟新鲜度同时满足才显示错误比例。无数据、样本不足、过期均中性；错误率不是作品交付失败率，也不保证下一次生成成功。

生产只读核对：现有运行模式为 V1，V2 无可用水位/近期图片视频聚合。本轮不切换生产监控，因此上线后在该现状下显示“暂无状态数据”符合事实。Group31有多个Account，不能把汇总声称为Account77或Banana单渠道状态。历史缺失requested_model的日志不作猜测归属或回填。

## 发现并修复的原生统计遗漏

新同步图片 HTTP502 无交付会正确产生 failed/not_charged receipt，但任务 API 外层 HTTP200 会被原生Ops视作已恢复，漏掉逻辑失败。`studio_images.go::markStudioImageTerminalOpsFailure` 仅在本次真实POST、当前原生502上下文、可信终态失败证据、无交付/无pending时复用原生 in-band error 标记。保留客户任务API200及原有资金终态；查询、重放、partial和unknown不增加该失败样本。没有新建监控表或服务。

## 已完成本地验证

- 74项定向Vitest：13比例、10模型选择、51现有Studio面板，PASS。
- Vue类型检查与受影响ESLint：PASS。
- 桌面/390px、浅/深色、键盘和交互定向浏览器7项连续3轮：21/21 PASS。
- `evidence/local-vue/` 是正式Vue组件的本地合成fixture截图，不是生产截图，也不是最终镜像联调证据。
- 最终Core＋Bridge＋BFF＋PostgreSQL＋模拟上游验收在GitHub-hosted既有候选流程运行；没有Vite、浏览器API mock或真实供应商。

Banana配置与真实采购/售价缺口见 BANANA_TEST_PLAN.md；用户已说明此前没有保存草稿，故已停止“保存失败”调查，不替用户重存。

## 成品验收发现的两处收尾问题

- Run 38781772779 的真实监控矩阵、权限、状态详情与四种屏幕截图已通过，但要求4条逻辑502记录时实际查到0条，整组验收失败。原生 `ForwardImages` failover只写入 `OpsUpstreamErrorsKey` 事件；最初新标记只检查单值 `OpsUpstreamStatusCodeKey`，造成漏记。修订代码复用现有 `applyOpsUpstreamFieldsFromContext` 的最后尝试解析，不重写规则。event-only 502反例在修复前FAIL，修复后原生Ops中间件、单次落库、重放/partial/unknown排除及最后一次断线/鉴权失败回归PASS。资金与客户终态逻辑未改。
- 最终镜像390px截图暴露模型弹层顶部被导航遮挡。修订为手机视口内有上限的弹层，保持A标签、模型选择和键盘行为。1440/390px×浅/深色4项浏览器回归PASS，加入最终镜像垂直可见范围断言。

原0b候选不作为通过候选交付；只因以上实际运行代码变化构建15da修订版（Run 38784147330），并沿用既有云端验收。未重新执行104笔资金和1870规模专项。
Vue类型检查、受影响ESLint和新增Go回归均已PASS。最新候选结果以同目录HANDOFF及最终manifest为准。

最终Run 38784147330 PASS：4条502逻辑记录准确落库，比例完整执行及矩阵/权限/手机与桌面截图通过；完整指纹与证据见HANDOFF。生产未部署。
