# d893690a 生产部署、客户资金与原生告警核查

最终状态：**DEPLOYED_IMAGE_STATE_PRESERVED_VIDEO_DISABLED**。

2026-10-15已部署d893690a三组件，访问恢复。图片requested/effective均true，视频均false。没有商品发布、改价、mapping修改、真实供应商生成、原任务恢复或资金操作。未回退、未执行数据库迁移。

## A. 部署事实

运行源码：`d893690abe47f891aacde8876837ccc0c8b653ac`，三组件均来自该候选。最终测试提交`465d05f35ad2e6d0a3c3fe6e12ec884b927caa0c`不是运行源码。

[候选Run 38647616053](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38647616053)，完整Artifact11933596314；manifest SHA256 `97e63251df6c17ebc401a1cc94330eac0f4518ba225e7393b5ba950cd6d2222e`。沿用既有CI38648428557、Security38648428594与隔离验收，没有重建。

本地及服务器分别复算manifest/TAR，验证OCI config关联。两种摘要是不同对象，不应直接比较字符串。

|组件|config digest / Image ID|运行OCI manifest digest|
|---|---|---|
|core|`sha256:46380c683487c313de1f988a2879fe6106768333cf2c7ecd35dc05156b319d7b`|`sha256:a0f6c2d9ff5ab1fa269d9ff5e8ae4ca9b4f6df988bffaa5020b7be4a95a818c2`|
|bridge|`sha256:af9114c9d2b6e835f1ea890e421f43bbdb14c1cbffa312e00bc2cd85082d86fa`|`sha256:7c7db67cea0a4ea08425246627b5113c613b8c0468ed8d212231e6f98e755787`|
|bff|`sha256:5fee96b658de52b4b58c2b2476c58b307c6b610ec6a7276b1e6b6cd5b2caf719`|`sha256:ba87605bc65d9a3547e3bd7e59c612319967c4bc104bfc4acb619512176fbbe6`|

生效Compose project为`ai-gateway-media`：
- base：`/home/ubuntu/services/ai-gateway/phase5-launch-20261010-final-3bb336b/compose.json`
- overlay：`/home/ubuntu/services/ai-gateway/deploy-image-task-d893-20261015/compose.override.d893690a.json`

仅替换三个镜像引用，环境、凭据、managed-v1、legacy false及持久挂载不变。Core健康后重建Bridge/BFF，均附着新Core网络命名空间。PostgreSQL、Redis容器身份未变且健康，Caddy active，未改路由。

### 图片状态恢复

实际部署前图片开启、视频关闭。managed-v1的随机进程epoch会使旧开启授权在重启后失效。已向用户说明并得到明确答复“允许预检通过后恢复图片开启”。新Core先确认双关，完整预检通过后使用现有管理员页面“开启图片→确认开启”。唯一PUT完成于北京时间 **07:57:39.920**，HTTP200，服务端再检查耗时1.132秒（整个PUT）。视频Apply未调用，Account sales标记不变。图片依赖fingerprint前后相同，仅授权revision更新。

### 生产非付费验收

- 三组件healthy；Core8080、Bridge8094、BFF4174按真实服务合同核验。图片readiness受保护路由返回401而非404。
- 运行Core完整135,983,264字节SHA256为`41e206983b6ec5db2dc7ca942896c0e4d4e6b5bef3778a39d3ef8d78302d113b`；Bridge/BFF文件同样匹配接受候选。多图用量修复运行代码已上线。
- [管理员页面](https://laifufu.top/admin/media)、[客户作品桌](https://laifufu.top/video-studio)来自生产Core。普通URL的17份浏览器实际JS/CSS与源站逐字节一致；HTTPS、MIME、无挑战检查通过。动态HTML只比较路由和资源引用，不声称全文一致。
- Account #77全部 **1,870** 个规格检查PASS，含文生图、参考图编辑、正数售价、权限、成本、私有存储。最后一次页面 **1.306秒**，服务端 **1.055秒**；未延长30秒时限。
- 服务端阶段：初始依赖25ms、资格/存储3ms、发布校验95ms、规格编译274ms、原生报价635ms、最终依赖21ms。阶段舍入，总耗时独立计时。
- 客户非付费报价：文生图、编辑均HTTP200；4K / 16:9 / 3张，单价0.025 CNY、总价0.075 CNY。未点击生成。
- 1440px和390px文生图/图生图表单可见，图片关闭提示消失；视频仍显示关闭。截图已人工检查，无横向溢出或遮挡。
- 当前管理员会话是用户#1，原unknown任务属于用户#2。未冒用用户#2，也未调用可能恢复/结算的任务GET。等待动画、unknown继续创作、查询加载/错误和双任务独立结算复用**同一d893候选隔离证据**，不冒称生产真实生成已成功。

验收器首次在模式加载完成前350ms读取提示，产生时序断言失败；只修等待条件并补采证据。一次本地UTF-8补丁未生效，旧验收器随后点击已经禁用的开启按钮超时，没有第二次PUT。三次非付费检查均200，只有一次实际开启PUT。视频缺省不存在的控制记录用空列表比较核验，不创建记录。没有运行代码修改或因此回滚。

### 业务保护、时间与恢复

- Account #77仍 **1份**商品；全部Account的商品/凭据/mapping指纹不变。用户余额、usage末尾、视频订单更新时间保护指纹不变。原任务回执摘要前后相同，仍unknown/pending，无原片/上游任务ID。
- 迁移ledger前后SHA均`d6a8f75d4ae22b8a460a31de549f4865b710699f18a233d62408491b61f5631f`。没有新SQL或迁移。
- 不声称整个数据库零写入：正常登录、授权的非付费报价/存储检查及图片运行授权记录在本次范围内。未修写商品、价格、订单或资金。
- 首份现场预检 **07:31:18.857**，最终保护核对 **08:03:05.198**，可核对执行区间约 **31分46秒**；更早准备和文档同步另计。下载约13分钟、上传约5分钟，均在维护前。
- 切换脚本 **07:56:40.477–08:00:32.277**，约3分52秒，含浏览器验收和验收器纠正。
- 服务切换 **07:56:42.484–07:57:19.949**，**37.465秒**。从切换开始到图片恢复 **57.436秒**，是覆盖重启和预检的区间，不把下载算停机。
- 唯一本地完整候选：`D:/AI-Gateway/output/image-task-20261015/candidate/`。已删除校验解包后的临时外层ZIP212,559,395字节，保留三份正式TAR。GitHub完整artifact到期北京时间2026-10-29 06:35:14，本地归档已补齐。
- 恢复证据：`/home/ubuntu/services/ai-gateway/deploy-image-task-d893-20261015/before/`；原1ab整组镜像仍存在且inspect通过，原overlay在`deploy-preflight-1ab3838a-20261015/compose.override.1ab3838a.json`。
- 本轮没有回退。必要恢复须先核对持锁归属与数据兼容，按Core→Bridge/BFF恢复1ab整组和原配置，不覆盖数据库、Redis、journal或原片。旧Core重启也使图片授权失效，需重新预检并在授权内恢复，不能承诺只换旧镜像就恢复开放。

## B. 指定任务资金

**此任务本站原生实际扣款0 CNY，没有报价预扣或当前余额占用，无需释放/退款。** 依据实际执行路径、同事务原生dedup/归档/usage、receipt、数据库frozen_balance及Redis精确占用键，不是只凭usage=0。

pending不是未提交的资金事务。未来若合法取得有效原片，现有合同允许按冻结价首次结算，原生幂等防止重复结算。没有完整历史余额快照，不能重建整个账户历史，更不能由本站0扣款推断供应商已退款。

[完整资金与告警审计](production/FUNDS-OPS-READONLY.md)；[资金证据](production/funds-summary.json)。

## C. 原生运维告警

04:52:50两条告警实际均为5分钟overall窗口，**成功0、失败1**，唯一失败对应本任务；补核15分钟仍0/1。错误表是外层409，既有执行日志确认内层502，不是多笔大范围持续故障的证据。

核查时最近15分钟无新样本，评估器心跳正常。无样本分支跳过active事件解除，旧firing因此仍显示；没有大于1的最低样本门槛，低流量百分比易误读。未改阈值或新增监控。最小后续建议：现有页面增加样本数、最近有效窗口和“当前无数据”，是否设最低样本量另行决定。

## D. 未解决事项与停止

供应商502内部原因、该笔最终执行和退款状态仍缺可靠单笔回执。冻结API主机已确认`api.image2pro.top`，不是网站/API域名误用。未删除unknown任务、重发POST、补扣或退款。

本轮部署及授权检查完成，图片保持原开启状态、视频关闭；真实生成由用户决定，不保证上游下一笔成功。正式根Handoff/Constraints保持原文，本报告供ChatGPT更新交接。未自动开始其他工程。

## 截图与证据

均为本次生产域名最终Core，未生成作品。控制截图只截必要面板，不公开管理员个人资料和余额。

- [桌面文生图](production/production-text-1440.png) / [桌面图生图](production/production-edit-1440.png)
- [手机文生图](production/production-text-390.png) / [手机图生图](production/production-edit-390.png)
- [桌面实际开关](production/production-paid-panel-1440.png) / [手机开关](production/production-paid-panel-390.png)
- [手机视频关闭](production/production-video-390.png)
- [部署汇总](production/deployment-summary.json)、[浏览器及报价](production/browser-checks.json)、[运行文件](production/runtime-files.json)、[17份资源](production/public-assets.json)、[唯一恢复PUT](production/activation-log.json)。

|门槛|本轮证据与结论|
|---|---|
|PUB-01|PASS，HTTPS正常证书/路由；TLS设置未变，不推断未读取的Cloudflare配置模式|
|PUB-02|PASS，页面/资源状态、MIME、无挑战；内部认证401按合同|
|PUB-03|PASS于动态页面资源引用、JS/CSS字节范围，不声称HTML全文一致|
|PUB-04|PASS，OCI/config/运行文件；普通URL实际VideoStudioView-DfyUczpO.js等资源与新Core一致|
|PUB-05|PASS于健康、登录、导航、全量非付费预检/报价；未执行生产生成和原任务恢复，隔离证据单列|
|PUB-06|PASS，前台部署锁、冻结基线、漂移保护、恢复镜像/配置与失败证据；未回退|
|ART-01|PASS，本地/服务器完整TAR、OCI关联和实际运行文件完整SHA，无截断|
