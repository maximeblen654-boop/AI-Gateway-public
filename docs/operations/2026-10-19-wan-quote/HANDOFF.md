# Account #44 WAN3.0 原生报价诊断

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
