# c6af2299 生产部署执行交接（2026-10-15）

**最新现场：DEPLOYED_IMAGE_DISABLED_PRECHECK_BLOCKED。** 三组件已上线，访问已恢复；图片和视频付费提交均关闭。原图片报价 409 已在生产的两条非付费链路消除，但管理员完整开启前检查超过 30 秒客户端时限，不能宣称具备开放条件。本文件是对同目录开发交接的生产执行补充，不替代根正式 Handoff/Constraints。

## 固定身份和时间

- 运行源码：`c6af2299086831f99a40b045b889ce72573aadc2`；验收脚本：`f60f684999fcf0b2e212bb238df7d0a33b3ae2d5`。不是文档 HEAD。
- 原候选 Run [38612619132](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38612619132)，Artifact `11918028540`；manifest SHA-256 `9364d33ef3562968978991d17bfa09ff4e64a300d90a86e7755f00ffd66d7eef`。
- 生产切换北京时间 **02:51:42.402–02:52:26.858**，44.456 秒（不是声称整段均断网）；三组件全部 healthy 于 02:52:16.943，随后公网检查通过。未设置维护页，正常访问已恢复。
- 切换及登录后验收锁内结束 03:01:48；最终只读确认 03:02:38。可核实的预检证据 02:40:36 至最终检查共 22 分 02 秒；此前规则读取、首次连接和等待不计在该区间内，不以此冒称完整会话耗时。准备中一次 GitHub CLI 下载无进展，改用**同一个 Artifact** 的签名下载成功，未重建、未换包。

| 组件 | config digest / Image ID | 实际 OCI manifest digest |
|---|---|---|
| core | `sha256:8fcdb2a0c4fbee281f0df2abbf2d8a4a1ce4a5f651ef7aabfa9a92cd5601923d` | `sha256:e0aeec12b9bb77011fe60b87a4c500328ac55ecb293b4d60756f988ee2baad6d` |
| bridge | `sha256:caf64e63e1a1f29b4685795e8fb585c40bb1f75ebd2cf52232a3814195db3dec` | `sha256:9cf2285b85924cd062d22be05eeacd88d2c1148c7cfbc632d49897f6bfb7e82a` |
| bff | `sha256:fe7407d6abbfb3d84c6f1270a1a2cae94a47ba1b3ebf723087c692b83ce456ac` | `sha256:c821cccd98d6bfe4dc5762e005fe3bc6f713780ef2741a5022f4bd45e69740f5` |

- `core-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz` — SHA-256 `a1070f752822346b7475758e794fc00d3752d1dff552ea82a743c71de223c10e`
- `bridge-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz` — SHA-256 `c17c638fd8899efdfd7ea572df070ce234b15916490c23db9f02696aefa398d8`
- `bff-c6af2299086831f99a40b045b889ce72573aadc2.tar.gz` — SHA-256 `26d3cd853827b65a2f600b828f1da415fb0c87377b5db699008788e8499a9ab4`

完整候选仅保存一份：`D:/AI-Gateway/output/deploy-paid-controls-20261015/candidate/`。原 cloud artifact 于 2026-10-28 18:16 UTC 到期；本地和生产发布目录的归档不依赖该临时有效期。

## 生产配置与保护

Compose 项目 `ai-gateway-media`。基础文件：`/home/ubuntu/services/ai-gateway/phase5-launch-20261010-final-3bb336b/compose.json`。
新增生效 overlay：`/home/ubuntu/services/ai-gateway/deploy-paid-controls-c6af2299-20261015/compose.override.c6af2299.json`。

实际差异仅三组件镜像、三组件 `STUDIO_PAID_CONTROL_MODE=managed-v1` 和 Core 的实际内部控制地址：Bridge `127.0.0.1:8091`、BFF `127.0.0.1:4173`。原配置渲染后逐项比对，其他字段不变。旧环境图片、视频提交及适用的 receipt worker 开关均 false。

Core → Bridge → BFF 定向重建，两个 sidecar 均附着新 Core 的 network namespace；挂载不变。健康探针分别使用实际宿主映射 8080/health、8094/health、4174/health，全部 200。受保护的图片 readiness 路由匿名返回 401，不是 404。PostgreSQL、Redis、Caddy 和无关旧 sidecar 未重启/替换。

候选与现网迁移逐文件/checksum 比较无待执行项或漂移。生产迁移账 293 条（含既有 studio_video_orders 记录）前后 SHA-256 `d6a8f75d4ae22b8a460a31de549f4865b710699f18a233d62408491b61f5631f` 不变。未执行迁移。

Account #77 **仍是 1 份商品**，原 sales=true 保留；与全局 paid=false 区分。全部 Account credentials/media 配置指纹前后相同；#77 商品 ID/规格/单价/状态指纹相同；用户余额聚合指纹、usage 最后 ID、视频订单最后更新时间均未变。没有商品保存、发布、启售、mapping 修改或余额/结算改写。managed settings 记录仍为 0，预检失败只在 Core 内存中置失败关闭，未执行 Apply。

## 非付费上线结果

真实管理员登录后 `/admin/media` 可访问，Account #77 原商品、向导和新付费控制面板正常加载；`/video-studio` 正常。1440/390 截图来自生产域名新 Core，不是 Vite/fixture。9 个实际加载 JS/CSS 资源的源站/公网完整摘要一致；三组件关键运行文件完整摘要与候选证据相同。

通过真实客户会话的 BFF → Bridge → Core 报价：

| 路径 | 真实已发布规格 | 响应 | 耗时 | 结论 |
|---|---|---|---|---|
| 文生图 | 4K、16:9、count=1、images=0 | 200 / published_image_binding_v1 | 543 ms | 原生冻结单价与原发布售价一致，quote 已签发 |
| 参考图编辑 | 同上，images=1 | 200 / published_image_binding_v1 | 517 ms | 原生冻结单价与原发布售价一致，quote 已签发 |

没有准备/上传素材、创建生成任务或提交生成；只产生本次授权允许的本地非付费报价记录。两条报价通过不能证明生成、交付或资金结算的生产实付验收。

## 精确阻塞：管理员完整预检超时

真实页面点击“开启前检查”后 Axios 在 **30,000 ms** 中止，页面显示“检查失败，未执行开启”。生产 Core 的完成日志耗时为 189764–197211 ms；HTTP 200 是服务端最终日志，浏览器没有收到完整检查报告，**不得写成预检 PASS**。过程中没有正式开启 PUT。

初期只有请求完成日志尚未出现，曾排查浏览器/CDP连接；后续完成日志已证实请求实际到达 Core，是长时间检查，不是已证实的边缘拒绝。包括该诊断在内 5 次非付费检查已结束，最终 Core CPU 0.59%，未保留后台压测或重试任务。

与真实配置相符的代码耗时放大路径：

- `frontend/src/api/client.ts`：统一 30 秒 timeout。
- `backend/internal/service/studio_paid_preflight.go::check`：遍历完整 PublishedOfferSpecs，逐项调用 `ResolvePublishedImageOffer`。
- `backend/internal/mediaworkbench/runtime.go::ResolvePublishedImageOffer`：每项调用 `publishedReady`。
- `backend/internal/mediaworkbench/adapter.go::publishedReady`：每次对整个 Published products 调用 `Validate`。
- #77 当前正式配置 1 个分辨率 × 11 比例 × 10 数量 × 17 参考图数量（0～16）= **1,870** 个组合；无组合排除。因而出现每规格重复全量校验的二次方规模工作。这是源码可确认的放大机制；没有采集 profiler，不能声称它是所有耗时的唯一来源。

没有通过调小商品规格、改执行上限、删除参考图、改价或延长生产代理超时掩盖问题。图片状态 requested=false/effective=false，reason=apply_failed（预检失败共用该内存关闭原因）；视频 requested=false/effective=false，reason=closed。**暂不具备让管理员直接开放图片的条件。**

下一步最小处理建议（本轮未执行）：非生产定向修复预检的重复完整校验，保持每个可售规格覆盖和冻结依赖一致；补 1,870 组合规模及取消/超时回归，再准备修订候选并单独授权上线。不要仅延长前端 timeout 或把全部规格缩成抽样。开启动作会再次预检，也必须覆盖。

## 发布守卫与恢复

| 门槛 | 结果 | 证据/边界 |
|---|---|---|
| PUB-01 | PASS | 实际 HTTPS 域名/路由、正常证书验证，无 TLS 或 Caddy 变更；没有声称核实 Cloudflare 控制台加密模式 |
| PUB-02 | PASS（页面/资源/报价范围） | 正常 MIME、无挑战替代响应；完整预检超时另列 FAIL |
| PUB-03 | PASS（既有窄 HTML 变换） | 复用原验证器；JS/CSS 不采用 HTML 例外 |
| PUB-04 | PASS | 新运行字节、登录后资源和源站/公网摘要一致 |
| PUB-05 | PARTIAL / preflight FAIL | 三组件、登录页面、两种报价 PASS；开启前检查超时，整体验收不得报 PASS |
| PUB-06 | PASS | 失败时间/阶段/请求日志、原组配置及镜像已保留；无可用浏览器预检响应体，明确 UNKNOWN |
| ART-01 | PASS（本次候选范围） | 复用同输入隔离 Run；本地/远端 TAR 全量校验，OCI→config 关系，运行文件大小和完整摘要均核对 |

没有回退。当前页面和独立非付费报价正常，完整预检失败按本次授权保持关闭并报告。原组为 **15d Core + b2 Bridge/BFF**；配置、镜像引用和 baseline 位于生产发布目录 `before/`，旧镜像和归档均保留。
若后续批准组件回退，先重新确认配置/所有权/迁移和业务状态兼容，然后按原 overlay 定向 Core → Bridge/BFF 恢复网络附着；不整库恢复，不覆盖 Redis/journal/原片。当前未执行恢复。

本地完整执行证据和截图：`D:/AI-Gateway/output/deploy-paid-controls-20261015/`。截图含管理员身份/余额等私人页面信息，仅本地交付，不上传公共 GitHub。
脱敏机器证据：[DEPLOYMENT-EVIDENCE.json](DEPLOYMENT-EVIDENCE.json)。正式 Handoff 与 Constraints 保持原文，由 ChatGPT 根据本回报更新。

**最终停止：DEPLOYED_IMAGE_DISABLED_PRECHECK_BLOCKED。未开启图片或视频，未发布商品，未发真实供应商请求，未执行实付测试。**
