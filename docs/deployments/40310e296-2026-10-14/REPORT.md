# 作品桌生产部署最终回报

状态：**DEPLOYED_SALES_DISABLED**（全局付费提交关闭）。作品桌已上线、访问恢复；此报告仅记录作品桌部署；计算器后续单独开发、未上线。

必须区分现有 Account 标记：#77 在本次切换前已是1份商品，Account sales.enabled=true；发布状态也是既有状态。本次整个媒体配置指纹前后一致，没有改写。全局图片/视频提交=false，客户 readiness paid_enabled=false；没有因部署开启实际生成入口。

Core 源码40310e2961a5e8150e0c9df4cc86bb8087406c06，Bridge/BFF 精确复用b2fcdac93afa6ae194ee81801a9b37813f8f39eb。
生效 Compose：/home/ubuntu/services/ai-gateway/deploy-40310e296-20261014-r2/compose.override.40310e296.json；基底和全部环境、挂载不变，仅 Core 镜像引用变化，两个 sidecar 定向重建附着新 Core。

- Core config: sha256:937d75ef1933a6278db3434dfd5992ec452ad79aa0bd84b8d978b4c927e41132
- Bridge config: sha256:dd01aa29e152f589679e5065037459240aeb8ddfe3ec853c16033006fe67acda
- BFF config: sha256:e498b97225bfc15e286af26bff30ec5c8d84526adfdbcd8231ebf7bad50e3f21

完整 OCI/TAR 对应保存在本地部署证据 loaded.json、attempt2/loaded.json，manifest 为 fe55c4ed2e5a11a9cf16cbbbc0cda5113fa4bc8fcbb43d94f2b66effbd8a306c。只传新 Core，复用服务器已有 sidecar 镜像和 TAR。

三组件 healthy；Core8080、Bridge8094、BFF4174健康200，Bridge受保护readiness401。PostgreSQL/Redis/旧sidecar容器ID不变，Caddy active配置不变，部署锁已释放。293条完整迁移记录checksum前后一致，无迁移。
36份候选JS/CSS与生产源站/普通公网URL字节一致。正常管理员会话完成作品桌文生图/编辑/视频/历史导航及管理员返回模型列表、发布位置检查；1440和390视口实际截图人工检查。没有报价、素材准备、生成、商品保存或发布；没有选择历史任务触发供应商轮询。现有记录为空，未补造下载记录。

## 必须保留的异常经过

第一次三组件已健康、资源和页面已通过，但原脚本在 SCP 验收JSON尚为空时读取，引发JSON解析异常，并错误触发了组件回退。已恢复b2整组且配置/数据保持。此次回退不是作品桌运行缺陷，不隐瞒该错误。

根因已确认后，改为上传临时文件→SHA/JSON校验→同目录原子rename；记录解析异常单独保留待验状态，不自动回退健康服务。重新核对确为本次恢复的容器ID与原配置/商品/迁移指纹后，执行一次受控重试；最终成功。没有重建候选或恢复数据库。

## 时间

记录起点UTC 2026-10-14T01:36:54.946827+00:00；最终确认UTC 2026-10-14T02:01:25.268348+00:00；总历时 24.5 分钟（含登录等待、取证工具缩放修正和一次恢复/受控重试）。
首次操作窗口36.2秒；最终操作窗口UTC 2026-10-14T01:59:36.466576+00:00 至 2026-10-14T02:00:12.932545+00:00，36.5秒。首次恢复时间见attempt1-restored.json，不将两次切换合写成一次36秒完成。登录等待与准备重叠，未单独精确计量。

登录窗口原先固定模拟1440×1000超过用户实际窗口，用户缩小至25%才见密码；验收已恢复100%并检查真实CSS视口。后续登录应使用自然窗口viewport:null并在展示前确认表单可见，不再要求用户缩小。

## 证据

最终证据在attempt2/：post-check-final.json、dependencies-final.json、public-assets.json、browser-acceptance.json、workspace-desktop.png、workspace-mobile.png、admin-desktop.png、admin-mobile.png。
PUB-01/02/03/04/05/06 与 ART-01在已声明非付费范围通过；TLS、代理机制未改变，资源精确比对、浏览器实证和候选验收分别记录。正常登录可能写会话/登录日志，不宣称整个数据库零写入；商品、权限、价格、mapping、原片、usage与任务资金未被修改。

Handoff59原样同步；Constraints保持。后续计算器仅在非生产工作区开发，单独审核，不沿用本次部署授权上线。


生产截图：[作品桌桌面](workspace-desktop.png)、[作品桌手机](workspace-mobile.png)、[管理员手机](admin-mobile.png)。截图仅证明读取与页面，不是实际付费生成验收。

管理员桌面原截图含登录账号与余额，仅保留本地部署证据，未上传公开Git；公开管理员手机截图不含这些内容。
