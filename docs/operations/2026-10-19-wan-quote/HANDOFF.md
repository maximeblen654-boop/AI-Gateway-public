# Account #44 WAN3.0 原生报价诊断与配置引导

## 后续增量：双业务成本配置引导

源码状态：**SOURCE_READY_NOT_DEPLOYED**。生产报价状态仍为 **BLOCKED_QUOTE_CONFIGURATION**。

固定源码 `1ce98f14979009a54801f553267b053e6596ce90`，继承诊断修复47847205。已读取私有规则提交 `cda81316597f12ef0fb516cc295187bd78cc5747` 的双业务约束；只fetch和读取，没有覆盖主工作区未提交AGENTS。正式Constraints/Handoff原件未改。

### 最新生产只读审计

2026-10-19再次通过登记SSH、BEGIN READ ONLY查询：channels表为空，channel_groups表为空；不存在可无冲突直接复用的Channel。Account44仍active/schedulable、销售enabled=true、record_version=5。精确商品、SiteModel、UpstreamModel、Offer与下文证据一致；本轮不扩大到同Account其他WAN、聊天或图片模型。

原生链路：Key/Group决定访问与模型权限；Group关联Channel后，视频报价从该Channel的AccountStatsPricingRules中匹配Account ID、平台和UpstreamModel，之后仍须通过原生Account调度/运行准入。Studio只从PublishedVideoOffers/PublishedImageOffers形成目录，未发布模型不会因此出现在Studio；同Account其他聊天模型的原生API权限独立。原生Channel还可能影响模型限制、映射、计费模型来源和定价，不能当作一个无副作用的媒体成本容器。

### 实现

- 视频缺失/无效Channel：`quote_cost_channel_missing`。
- Channel存在但没有精确匹配的采购成本：`quote_cost_rule_missing`。
- 匹配规则为非按次、带区间或time_pricing：`quote_cost_contract`。
- 其余成本校验保留`quote_account_cost`；所有原有拒绝条件和errors.Is原因保留，图片原有可选/必需成本逻辑不变。
- 管理员预检报告携带实际检查Group ID（只读上下文，不是路由覆盖值）；诊断保留Account、Product及可读取的精确UpstreamModel。
- 成本失败时展示Group/Channel职责、普通API影响、采购价/售价/浏览器估算区别，并提供已有 `/admin/channels` 新标签页入口。没有创建/绑定/保存按钮，没有自动写入，没有新增成本引擎或供应商体系。
- 现有浏览器成本换算器未修改，其估算不写入原生成本。

### 验证

PASS：WAN有/无参考两路径，缺渠道/缺精确规则/不兼容计费、映射/Group/调度/权限/非法规格拒绝；已有Channel对象前后序列化完全一致；预检不新增报价文件。新增同Account聊天+已发布视频目录测试，Studio只显示视频Offer，移除视频Group权限不影响聊天原生允许状态。原生 `TestGroupIsolation_` 调度回归、图片报价保护、StudioPaid和视频preflight系列PASS。

PASS：MediaPaidControls 5项组件测试；完整vue-tsc --noEmit；相关Vue/TS ESLint。类型检查发现published.products可能缺省，已用可选访问修正后重跑通过。没有生产浏览器写入测试，没有供应商网络请求。

命令：
```
go test ./internal/service -run 'Test(WANQuote|QuoteDiagnostic|StudioVideoPreflight|StudioPaid|StudioImage(QuoteOwnership|IssuedAccounting|IssueFreezes|AccountingAdmission|NativeKeyPolicy|ExactAccountDrift)|GroupIsolation_)' -count=1
go test ./internal/service -run TestWANStudioCatalogDoesNotOwnChatPermissions -count=1
node node_modules/vitest/vitest.mjs run src/components/admin/media/__tests__/MediaPaidControls.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/eslint/bin/eslint.js src/components/admin/media/MediaPaidControls.vue src/components/admin/media/__tests__/MediaPaidControls.spec.ts src/api/admin/mediaPaid.ts
```

### Account44最小配置方案（未执行）

1. 用户确认 `WAN3.0-可参考视频` 的真实采购币种、金额及单位：每次、每秒还是随时长/分辨率/素材变化；不得把客户5/10/15秒售价当成本。
2. 若确为固定按次采购，另行审批在现有原生渠道管理创建一个经影响审查的Channel、关联已有Group31，并仅为Account44/openai/精确UpstreamModel配置明确的按次采购规则。无需新建Group或重复录入Account密钥。
3. 创建前必须核对模型限制、Channel mapping、计费模型来源、客户定价、账号统计定价等设置对Group31现有聊天/图片API的影响；不得把渠道限制为仅WAN从而误封其他业务，不擅自填写默认值宣称无影响。
4. 若采购按秒/规格变化，当前视频成本快照仅支持明确per_request且不接受interval/time_pricing。此轮不能给出安全的固定按次配置；需先确定真实合同及后续兼容方案，不猜价、不绕过。
5. 单独授权写入后才能执行配置与非付费预检；视频false/false保持，商品售价、发布和销售不动。通过报价检查不等于允许视频付费提交。

本轮未部署或重启；图片true/true、视频false/false沿用最近认证验收事实，本轮未重新取得管理员会话，不冒报实时effective读取。C/D收尾约4.71/27.35GiB可用，无磁盘清理；复用现有依赖与Go缓存。停止等待审核与商业数据，不自动构建/部署。

---


状态：**BLOCKED_QUOTE_CONFIGURATION**。诊断源码已就绪，生产报价仍需要独立授权补齐成本配置。本轮没有部署、生产写入、开关调整或供应商请求。

固定修复源码：`47847205adfa11edee50949f75f6bbfeaac8b7c7`，基于生产 `b5b23a1f01721d41d94fb03bc6ac8796453dd24b`（中间提交仅为既有文档证据）。工作分支 codex/media-paid-controls，源码工作区 D:/AI-Gateway-public-staging。D:/AI-Gateway 原有未提交工作保持原样。

## 精确身份与现场事实

Account #44，Group #31，平台 openai，类型 apikey，active、schedulable=true，无父Account；销售enabled=true，record_version=5。

- SiteModel：`WAN3.0-可参考视频`
- UpstreamModel：`WAN3.0-可参考视频`
- Product ID：`media-92a8e4ac-0ca9-4ece-bd6b-0921d2a55f97`
- Published revision：`mwp_cd812618cca06e84bd65ea110bd92ba1e688d9e859f5cf7a84c1a3e1841270e3`
- Offer IDs、已发布能力及生产镜像身份见[只读脱敏证据](production-readonly.json)。不将其他WAN名称、3.0、3.5或同Account其他模型视为本商品。
- 已发布协议inline_multimedia；720p；时长5/10/15；6个比例；image≤10/video≤5/audio≤5，总数≤14。目录包含精确上游名称；Group模型白名单enabled=false。Account映射没有该精确键，但原生GetMappedModel未匹配时返回原值；相同Site/Upstream在已发布商品上下文下的这一情况已隔离验证通过，不要求擅自添加映射。
- Group31在channel_groups中关联数=0；覆盖Account44的channel_account_stats_pricing_rules数=0。

## 两条路径的首个共同失败

`InspectPublishedOffers → VideoProfileModel → PreviewWithModel → ResolvePublishedVideoOffer → CompilePublishedVideoPlan`可通过，随后`resolveStudioAccountCost`失败。Group无Channel，channel=nil；函数末尾`a.HasAnyQuotaLimit() || !image`对视频必为true，返回ErrStudioImageAccounting。`StudioVideoRuntime.account`的最终运行准入检查在此之后，因此不能把尚未执行的准入当成已通过，也不能从汇总失败推导它是根因。

无素材和有素材在隔离fixture中均复现相同ErrStudioImageAccounting；补入**仅隔离**按次成本规则，两条路径正常。该检查由真实quote及preflight共用，没有发现两者为此使用不同成本门槛。fixture采用同一发布规格合同、合成账号/成本；没有上传素材、请求供应商或创建真实订单。并非重放生产报价接口，也不宣称供应商可用性已实测。

“至少一个已发布商品通过检查”只是所有Offer未获得准入后的汇总，不是第二个报价根因。

## 最小源码修复

1. studio_video_runtime.go：已发布Offer、Group模型权限、协议编译、Account读取、参考准备、成本、运行准入、报价存储按阶段包装错误；保留原拒绝条件及errors.Is语义。
2. studio_quote_error.go：未知错误由误导性的binding变为unknown；Error()与HTTP阶段只输出预定义白名单，不输出Cause、任意Stage或敏感字符串。
3. studio_paid_preflight.go：模型合同/预览编译失败明确execution。
4. MediaPaidControls.vue：阶段对应安全中文解释和检查方向；未调整发布/销售按钮。
5. Go与组件测试见提交。

| 条件 | 旧诊断 | 新诊断 |
|---|---|---|
| 无素材/有素材成本缺失、错模型成本、非视频按次成本 | quote_binding | quote_account_cost |
| 协议/请求模型/合同编译错误 | quote_binding | quote_execution |
| Offer/spec或Group归属不匹配 | quote_binding | quote_published_offer |
| Group模型白名单拒绝 | quote_binding | quote_model_permission |
| Account映射、调度或运行准入失败 | quote_binding | quote_account_admission |
| 未分类内部错误 | quote_binding | quote_unknown |

## 验证

PASS：新增WAN两路径成本复现；26个两路径分支用例（成功、相同模型fallback、权限、缺成本/错成本模型/错成本模式、Group、映射、调度、请求模型、时长、比例、素材）；白名单与敏感Cause不外泄。preflight不新增报价文件。

PASS：Go定向StudioVideoPreflight、VideoRuntime、StudioPaid系列；图片报价所有权、成本准入、Key及Account漂移保护；StudioNativeVideoParity。mediaworkbench、videoplan包全测PASS。

PASS：MediaPaidControls组件4项；完整vue-tsc --noEmit；受影响两前端文件ESLint。当前全局pnpm会尝试重装依赖并因非TTY拒绝，未执行清空/重装，直接使用现有node_modules中同版本vitest、vue-tsc和eslint完成测试。

具体命令：
```
go test ./internal/service -run 'Test(WANQuote|QuoteDiagnostic|StudioVideoPreflight|VideoRuntime|StudioPaid|StudioImage.*Preflight)' -count=1
go test ./internal/service -run 'Test(WANQuote|QuoteDiagnostic|StudioVideoPreflight|StudioImage(QuoteOwnership|IssuedAccounting|IssueFreezes|AccountingAdmission|NativeKeyPolicy|ExactAccountDrift)|StudioNativeVideoParity)' -count=1
go test ./internal/mediaworkbench ./internal/videoplan -count=1
node node_modules/vitest/vitest.mjs run src/components/admin/media/__tests__/MediaPaidControls.spec.ts
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/eslint/bin/eslint.js src/components/admin/media/MediaPaidControls.vue src/components/admin/media/__tests__/MediaPaidControls.spec.ts
```

## 需要另行批准的配置动作

通过原有原生成本管理能力，为Group31配置有效Channel关联，并为Account44、平台openai、精确UpstreamModel配置可匹配的per_request成本规则及用户确认的采购单价。当前视频解析器不支持把interval/time_pricing或其他计费模式当作按次成本；如果实际采购是按秒或随规格变化，不能猜一个固定成本使检查通过，需要先明确真实成本合同和现有规则兼容性。

不能用零售价、商品procurement提示或另一模型的成本冒充这份原生规则。新增Group/Channel关联可能影响同组其他原生调用，后续配置方案须检查具体影响，不自动改Group、mapping、零售价或发布商品。配置后再检查两条路径及最终运行准入；本轮不执行。

诊断源码具备进入独立候选构建审核的条件；本轮未构建候选、未部署。生产仍b5b23；最后认证确认图片true/true、视频false/false为前轮部署验收，本轮无有效管理员会话、不伪报重新认证读取。仅只读SSH/SQL取证，未改变上述状态。

正式Constraints及原Handoff未覆盖，本文件为供ChatGPT合并的事实增量。剩余阻塞是成本配置，不是发布/销售按钮设计。
