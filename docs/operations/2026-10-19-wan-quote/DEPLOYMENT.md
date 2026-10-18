# 8ad2eff 实际生产部署记录

状态：`PRODUCTION_DEPLOYED_VERIFIED`。固定应用已部署、维护已解除；2026-10-19 07:55:26 北京时间完成真实认证浏览器与服务端保护复核。27 项检查、48 张截图通过，没有再次登录、重新部署或付费生成。

## 实际切换与服务

生产 https://laifufu.top 。旧源码 `b5b23a1f01721d41d94fb03bc6ac8796453dd24b`，新源码 `8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1`。只复用完整 Artifact `12149012613` 的三个 TAR 和最终 PASS 证据 Artifact `12149958347`，最终 manifest SHA256 `485c4a8fcc54b31bb415304366f9244d33ed95a9fb63a6c43f0779451a7d0dca`；没有重新构建、替换候选或复制隔离配置。

| 组件 | 实际 image ID / OCI manifest | config digest | 健康 |
|---|---|---|---|
| core | `sha256:02246764463d28040bd4917ca4c6d0a9903d9977f377648ddb528e46b2e71d48` | `sha256:76a084ae2d253dfaf1d48fa5af2c8dfa8775a230c6e95822686fc25d5a0e965c` | healthy |
| bridge | `sha256:b3f8836b60b2baad304bb78747fea1e70298f865a1fba9fbf122f8409bc6b11b` | `sha256:5845bd670349d4c363c2732c248744a1de03b6329b7a34d9f1296c8150189bc0` | healthy |
| bff | `sha256:a15a5581e39eca3cd1dbe7d6faeb379cff23cc416a3b3539d39750ebd3e7b4cf` | `sha256:88ad43ec7b56f4f47ef653f26d3eed6187c8dcd9f00a433bedc2c9698cde39c8` | healthy |

实际 Compose base 与 proposed override 定向重建 Core、Bridge、BFF 各一次；Bridge/BFF 已附着新 Core container namespace。未重建 PostgreSQL、Redis、旧辅助组件或持久卷。实际运行文件 SHA 与固定 TAR 的 runtime-files 一致。最终容器 ID、启动时间、摘要及挂载证明见 [部署证据](deployment-evidence.json)。

- 维护开始：**2026-10-19 07:09:30 北京时间**。
- 应用切换开始：2026-10-19 07:09:38；最后组件 healthy：2026-10-19 07:10:15。
- 三组件、报价与数据门槛完成：2026-10-19 07:10:27。
- 维护结束：**2026-10-19 07:28:37**，实际窗口 **1147.7 秒（约 19 分 08 秒）**。窗口因验收执行通道问题超出预期，不能仅用约 36 秒的容器切换时间冒称停机时长。
- 图片：部署前、当前均 **requested/effective=true/true**。Core epoch 重启后依照授权，通过官方管理员完整 **1,870** 组合预检与 CAS 恢复；服务端二次 **1,870** 校验通过。客户端检查 1100 ms；两次服务端 total 分别 1095 / 1043 ms。视频始终 **false/false**。
- 维护在原生并发、WebSocket ingress、等待队列与未决任务排空后生效；503/Retry-After 和允许的只读入口经过实际探测。最终以 ETag CAS 恢复完整原 Caddy 活动配置；维护标记消失。

## 真实上线检查与保护

2026-10-19 07:34:37 再次只读采样：三组件均固定 8ad/healthy；`/health`、`/studio/`、`/video-studio` 均 200。源站/公网 HTML 仅容许已固定、验证过的 CSP nonce 与 Cloudflare RUM 差异；其余 HTML 与六个 JS/CSS 文件匹配，无挑战页或旧资源冒充。原始整页摘要因安全 nonce/边缘注入不同，未宣称逐字节相等。

32 张保护表逐表摘要与原基线相同；余额/冻结额、usage/dedup、订单、迁移、Account、Group、Channel、模型 mapping、商品草稿/发布及售价均未改。4 处业务文件目录共 124 文件的聚合摘要与原件一致，包括 5 个图片任务（2 completed、3 failed）、已保存 dispatch response、receipt、素材与原片。PostgreSQL/Redis 容器 ID、启动时间与挂载保持不变。未调用未决任务恢复，未删除或覆盖业务数据。

Account #44 / Group #31 / SiteModel、UpstreamModel `WAN3.0-可参考视频` / Product `media-92a8e4ac-0ca9-4ece-bd6b-0921d2a55f97` 仍 record_version 5、销售 true；Account #77 / Group #31 / SiteModel、UpstreamModel `gpt-image-2` / Product `media-290f101c-aad9-40bf-a48b-b506ae80c762` 仍 record_version 35、销售 true。没有代填采购成本、发布 Banana、修改售价或扩大图片准入。

普通 API：既有管理员原生 Key 的 `/v1/models` GET 200，74 个模型；无效 Key GET 401，usage/dedup/视频订单不变。仅证明原生目录和认证路径可用，**未执行真实供应商转发或生成交易**。

## 验收通道异常与恢复

1. 首次执行器漏设 UTC，造成与原 UTC 基线的时间戳序列化不一致；在开启维护前安全停止。补齐 `SET LOCAL timezone='UTC'` 后，原 32 表和全部业务文件完全匹配，未更新基线求放行；合成金额变异仍被拒绝。
2. v3 已完成切换和图片恢复，但临时浏览器 identity proxy 将媒体票据发到 Core，而真实 Caddy 路径是 Bridge 8094 并 rewrite 至 `/api/v1/auth/studio-ticket`；Studio 目录/历史无法认证。另外脚本在第 4 步检查仅第 5 步显示的保存按钮。失败证据保留，不作为生产功能 PASS。
3. 代理路径和向导检查已修正，增加真实 session owner 首末校验；只允许首次 owner 核验前的 session 401 挑战，其余 401/403 仍拒绝。完整本地 fixture 27 检查、48 截图通过，明确不是生产验收。
4. 为避免等待认证无限延长维护，独立审查并封存 release-only 操作。在唯一发布锁内重新验证固定运行文件/owned IDs、网络卷、官方内部认证 readiness、原生 Key 目录权限、32 表、任务/原片、排空与旧合同；仅 CAS 恢复自己的完整维护配置，随后重新验证公网和认证边界。该操作未重启应用、不改业务，也**没有伪造原浏览器 critical gate 通过**。

## 最终真实认证浏览器验收

2026-10-19 07:55:26 北京时间，在正常公网身份路径与同一个浏览器上下文中完成 **27/27 检查、48 张真实生产截图**。覆盖 1440×900、1366×650、768×844、390×844、360×844 的文生图、图生图、视频、混合历史筛选，以及 Account #44/#77 的规格、采购成本编辑区、价格输入、向导保存入口和手机侧栏开关/实际宽度。没有点击保存、发布、销售或生成。

客户比例与实际 Published catalog 一致，没有比例滑块；现有图片的实际解码尺寸为 3840×2160，原片下载与继续创作入口存在。管理员自定义比例、视频时长范围、原生图片格式配置入口按具体商品可见；现有 gpt-image-2 已发布能力没有新增具体输出格式，因此未虚报客户可选择额外格式。采购成本、发布和销售入口的界面读取通过，真实成本填写与发布仍由管理员决定。

首次和结束时均验证真实 Studio owner。最初一次校验早于正常票据交换，记录为失败并保留；修正为最多 20 秒的有界 bootstrap 等待，401 只在初始化阶段等待，403/500、错 owner、超时继续拒绝。6 项合成正反测试通过。最终实际首次 owner 在第 3 次读取得到 200，同轮最终 owner 再次匹配；122 个 Studio API 响应没有非预期鉴权失败，没有页面运行错误。原失败截图和结果保留，未改写成 PASS。

用户明确要求保留有效登录。本机已将有期限的本站管理员 JWT 保存到当前 Windows 用户的 Credential Manager，不保存密码、刷新令牌、Cookie 或 storageState。最后整轮验收直接复用保存的会话，**新增登录请求为 0**；浏览器进程退出后，另一进程再次通过官方 `/auth/me` HTTP 200 核验缓存可用。复用不续期，截止取官方到期与首次保存后 24 小时的较早值；网络或未知响应先诊断，不当作密码错误反复要求登录。凭据从未进入源码、公开证据或截图。该授权只用于会话复用，不授予额外生产变更权限。

最终封存的只读 finalizer 再次验证三组件精确身份、运行文件、原 Caddy、图片 true/true、视频 false/false、32 张保护表及全部任务/receipt/原片目录，实际返回 `PRODUCTION_DEPLOYED_VERIFIED`；没有再次切换应用。Node 验收与服务器已成功结束后，Windows 包装器读取 UTF-8 中文报告时暴露默认 GBK 解码问题，现已显式指定 UTF-8，并用同份真实完整报告验证读取；该包装器问题没有破坏认证缓存或远端验收结果。

[完整脱敏浏览器摘要与 48 张截图摘要](production-browser-acceptance.json)。全部原始生产截图保存在本机受控证据目录；公开代表截图：[桌面管理端](production-screenshots/admin-77-1440x900.png)、[手机管理端](production-screenshots/admin-77-390x844.png)、[视频短屏编辑](production-screenshots/admin-44-1366x650.png)、[手机视频编辑](production-screenshots/admin-44-390x844.png)、[手机图片工作台](production-screenshots/text-390x844.png)、[已保存原片详情](production-screenshots/existing-image-detail.png)。截图在浏览器原生 capture 时遮盖身份区和任务 ID，没有后期伪造页面状态。部分首轮布局截图记录图片加载阶段，原片可用性另由实际解码及详情截图证明。


## 恢复资产与边界

检查点 `/var/lib/ai-gateway/checkpoints/predeploy-8ad2eff-20261018T212207Z` 的完整性在切换前复核；真实隔离恢复结果继续复用（101 表/44,941 行、219 文件/140,597,629 字节、Redis 3,139 keys）。旧 b5 三镜像、TAR 和 Compose override 保留；没有数据库迁移、数据恢复或应用回滚。

维护解除前未发现新版 `cost_rules/cost_version/studio_published_cost`。正常入口恢复后管理员可能合法写入新成本字段，**不能继续假定旧版兼容**：再次回退必须重新保护写入、排空并核对实际合同；新字段/任务已存在时保留兼容版本并前向修复，绝不覆盖最新 DB/Account/receipt/journal。

VPS 最后余量约 22.10 GiB。本轮没有生产磁盘清理、真实付费供应商请求或其他业务配置操作。正式 Constraints、私有历史 Handoff 及主工作区原有未提交内容保留。

## 发布守卫

| 门槛 | 结果 | 依据 |
|---|---|---|
| PUB-01 HTTPS/入口 | PASS | 实际正常 HTTPS 200、原 TLS/代理范围保持 |
| PUB-02 安全与资源 | PASS | 正常资源无挑战，认证边界 401；不拿匿名 401 推断付费关闭 |
| PUB-03 源站/公网差异 | PASS（明确窄边界） | 固定 nonce/RUM、实际 SRI、6 静态资源与源站匹配 |
| PUB-04 运行身份 | PASS | 固定 TAR/OCI/config、运行文件、三容器与新资源 |
| PUB-05 健康与业务 | PASS（本轮非付费范围） | 三组件、1870×2、保护指纹、原生目录和真实浏览器 27/27 PASS |
| PUB-06 诊断与恢复 | PASS（条件性） | 备份、真实恢复、实际回退资产、唯一锁和维护 CAS；新成本合同边界保留 |
| ART-01 成品身份 | PASS | 原 TAR + 最终 PASS 证据、加载/运行身份，无重建 |

本轮固定版本切换与规定的非付费生产验收已完成；没有将模型目录 GET 或模拟生成冒充真实供应商交易。
