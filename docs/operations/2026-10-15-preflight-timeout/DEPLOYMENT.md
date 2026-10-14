# 1ab3838a 生产部署与完整图片预检（2026-10-15）

**DEPLOYED_IMAGE_DISABLED_PRECHECK_PASSED**。1ab 三组件已部署、访问正常；Account #77 全部 1,870 规格及文生图/参考图编辑原生非付费报价通过。图片和视频 requested/effective 均 false，未点击正式开启。用户可自行决定何时开启；开启动作仍会执行服务端二次检查，本次未执行生产 Apply。

## 精确版本与生效配置

- 运行源码：`1ab3838a0dc40a32973ae06cc440b210f0a9d842`；验收脚本：`3b3698723510c0ccea76ea681698113bd7d983b8`，不是文档 HEAD。
- 使用原完整 Artifact `11922663136`，配最终补验 Artifact `11923002799` 的 PASS manifest。最终 SHA256：`f1ad7be33ea23d1c3b5ebec2a562fb822eb854b50a3f1564ade70ae8bf0d9f35`。三个 TAR 均与原包相同，未构建或重复下载。
- Compose 项目 `ai-gateway-media`，基底 `/home/ubuntu/services/ai-gateway/phase5-launch-20261010-final-3bb336b/compose.json`。
- 生效 overlay：`/home/ubuntu/services/ai-gateway/deploy-preflight-1ab3838a-20261015/compose.override.1ab3838a.json`。渲染配置对比仅三个镜像引用变化；所有环境变量、端口、凭据来源、挂载、网络、managed-v1 与 legacy false 均保留。

|组件|config digest / Image ID|生产 OCI manifest digest|
|---|---|---|
| core | `sha256:63da522e6fec055511ebe3858159560928bf53fe39e02bb2bf1f1fc8b8d7c08a` | `sha256:422c068739614090c6417223076d9dc8728490d8b8145a26475cba7b53b3cc5e` |
| bridge | `sha256:5738acb0c36def030432e3aeceb54474e99f2b6e8879b1fcd3fc127d4f2d9fa9` | `sha256:597b99e4867fed388bfcce9b09f4ca41bbd0d17de25a65f81c791589656c2c2c` |
| bff | `sha256:435fb41d4cab784d0676c21a2ae4a514cfd7b2007823af5564a5569fc258755b` | `sha256:ad938ae7b8997241b84c60cc316774342e64dc23f7386ca94005d3ccbb43257a` |

- `core-1ab3838a0dc40a32973ae06cc440b210f0a9d842.tar.gz` — `488a0c5b7fbafb0a3c673957fcd1e0ca5ceacf73dd4da5361835c29bd7b03e83`
- `bridge-1ab3838a0dc40a32973ae06cc440b210f0a9d842.tar.gz` — `9975e570262eaea2caaf1588338cbbbdb65a36d041d7fe3370b1933d73049ea8`
- `bff-1ab3838a0dc40a32973ae06cc440b210f0a9d842.tar.gz` — `e6447e1812be54423cc99dbe8f87052e7eaca08fd45028123f5afc8f2f94ee83`

本地唯一完整候选：`D:/AI-Gateway/output/preflight-timeout-20261015/candidate/`。生产发布目录同 overlay 所在目录。现场 Docker 使用 OCI manifest digest 标识运行镜像，已从实际 TAR 验证其 config.digest 对应上表，不混淆两类摘要。

## 现场检查与完整预检

- 登记主机指纹严格校验，主机 `vps-d6b91174`。切换前确认 c6af2299 整组三组件 healthy、managed-v1、图片/视频关闭、#77 保存 1 份商品。剩余12.69 GiB，结束11.91 GiB。
- Core → Bridge → BFF 定向切换，两个 sidecar 均附着新 Core 的 container network namespace。三个关键运行文件全量 SHA 与最终候选相同。数据库、Redis、Caddy、无关 sidecar 容器/服务保持。
- 健康探针实际分别为 8080/health、8094/health、4174/health，全部200；受保护 image readiness 匿名401，非404。原有服务认证通过 managed 状态读取与两个 sidecar 控制合同核对。
- 公网 HTTPS `/admin/media`、`/video-studio` 正常；使用已有合法管理员会话，登录后页面读取与 Account #77 原商品读取通过。9个实际加载 JS/CSS 源站/公网完整摘要一致，无页面JS错误。HTML比对范围为路由、类型与资源引用，不声称整页字节相同。

|完整1870预检阶段（ms）|第一次|第二次|
|---|---:|---:|
|初始依赖读取|45|39|
|权限/额度与私有存储|6|4|
|完整Published校验|108|99|
|1870逐项规格编译|229|221|
|文生图、编辑原生报价|768|664|
|结束依赖重读|32|22|
|服务端总计|1190|1052|
|真实页面点击至响应|1444|1300|

两次均 Account=77、accounts_validated=1、specs_checked=1870、pass=true，全部6项检查PASS，依赖指纹相同。客户端仍30,000ms。总计包含少量未单独列出的计时开销。旧版生产约190秒是上轮证据，本轮未重新运行旧版压力检查。

第二次为补齐当前成功页截图而执行，非压力测试。初始截图收集器误选仍打开的旧失败页；发现后丢弃该画面并重新取得真实成功页，1440/390截图均人工检查。中间一次新标签未继承登录状态，停在登录页，没有发出预检。没有将旧页或候选截图作为生产证据。

独立客户 BFF → Bridge → Core 非付费报价：文生图544ms、参考图编辑554ms，均200、published_image_binding_v1。实际规格4K/16:9/count=1，参考图数量分别0/1；冻结单价/总价均与现有发布值0.025 CNY相同。没有上传素材、生成任务或真实供应商调用。

## 关闭和业务保护

- 图片：requested=false、effective=false、paid_enabled=false、reason=closed。
- 视频：requested=false、effective=false、paid_enabled=false、reason=closed。
- 三组件 managed-v1，适用的 STUDIO_IMAGE_PUBLISHED_SUBMISSION、STUDIO_VIDEO_ACCOUNT_SUBMISSION、IMAGE_RECEIPT_WORKER_ENABLED 均false。现有 Account #77 sales=true 保留，不与全局付费关闭混淆。
- 全部 Account 凭据/mapping/media 配置、#77 商品ID/规格/售价/执行设置、用户余额聚合、usage 最后ID24及视频订单最后更新时间保护指纹前后一致。没有保存、删除、发布、启售或改价。managed settings记录仍0。
- 仅新增获准的本地非付费报价记录、会话票据及预检存储写入检查；未修改余额、结算或业务配置。
- 两版本 migration 目录无变化。按迁移器 strings.TrimSpace 后的正式 checksum 核对292个候选文件，全部已应用、无漂移；生产293条含既有 studio_video_orders 额外记录。迁移账前后 SHA `d6a8f75d4ae22b8a460a31de549f4865b710699f18a233d62408491b61f5631f` 一致，未执行迁移。最初本地脚本按原始文件字节算摘要导致误差，已按实际迁移器规则纠正，未改SQL或数据库记录。

## 时间与恢复

- 首次有记录的生产连接：北京时间04:15:54；本地制品全量摘要完成04:17:00。
- 切换窗口 **04:20:47.931–04:21:25.335，37.404秒**，是串行切换及检查区间，不声称整个区间均不可访问。未挂维护页。
- 锁内完成04:24:22.675；最终只读状态04:24:35.273。首次生产连接至最终核对约 **8分41秒**；不包含此前规则阅读及随后报告/Git归档时间，无用户登录等待。
- **无回退**。兼容的部署前 c6 整组三组件、配置及私有渲染配置在 `/home/ubuntu/services/ai-gateway/deploy-preflight-1ab3838a-20261015/before`；原 c6 overlay、镜像和TAR均保留。原 overlay：`/home/ubuntu/services/ai-gateway/deploy-paid-controls-c6af2299-20261015/compose.override.c6af2299.json`。
- 如以后另获授权且现场身份、迁移与业务状态仍兼容，可定向 c6 Core → Bridge/BFF 恢复并重新附着网络，随后核对健康和双关闭。不得整库恢复，不覆盖Redis/journal/原片；不承诺未来写入后的无条件回退。

## 发布守卫与证据

|门槛|结果与范围|
|---|---|
|PUB-01|PASS：实际HTTPS/路由/证书验证；无TLS/Caddy变更，不声称检查Cloudflare控制台设置|
|PUB-02|PASS：页面、资源及两类报价正常状态/MIME，无挑战替代|
|PUB-03|PASS，明确范围：HTML路由与资源引用核对；JS/CSS严格全字节一致，未泛化删除未知HTML|
|PUB-04|PASS：运行文件与冻结产物一致，登录后实际资源源站/公网一致|
|PUB-05|PASS：三组件、认证、真实页面、1870全量预检及两类非付费报价；不包含生成实付|
|PUB-06|PASS：恢复资产、精确阶段/时间/摘要/保护指纹保留|
|ART-01|PASS：复用精确候选最终隔离证据，TAR本机/远端全量摘要、归档完整性、OCI/config关联与运行文件一致|

脱敏机器证据：[DEPLOYMENT-EVIDENCE.json](DEPLOYMENT-EVIDENCE.json)。实际生产截图及详细私有记录：`D:/AI-Gateway/output/deploy-preflight-1ab3838a-20261015/`；截图含管理员身份、余额和账号资料，不上传公共仓库。桌面/手机 `production-paid-controls-1440.png`、`production-paid-controls-390.png` 显示“检查通过”及图片/视频“实际未开放”。

本文件为实际执行交接，正式 Handoff/Constraints 未自行改写，由 ChatGPT 据此维护。**完成后停止，图片和视频仍关闭，等待用户自行决定开启图片及真实测试。**
