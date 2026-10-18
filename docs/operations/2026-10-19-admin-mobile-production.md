# b5b23a1f 生产部署增量（2026-10-19）

最终状态：**DEPLOYED_ACCEPTANCE_PARTIAL**。运行应用已切换；管理员五视口验收证据未齐。不替代或覆盖正式 Constraints/Handoff。

- 旧生产 `b9796b975c1ced95366d7e65c8976364664f658c` → 固定运行源码 `b5b23a1f01721d41d94fb03bc6ac8796453dd24b`。
- 北京时间 01:18:03 开始切换，01:18:48 完成服务、官方图片恢复和保护检查，约45秒；无回滚。
- Candidate 39144994561 / 完整Artifact12143512127；未重新构建。ZIP SHA256 `638770c4f2cee4ba8db21cf949975c52aad2650c8eef2642809bb3fa1006697b`；manifest `43912b83efa4b538c323a9ff2b214f6197bff59f17e3ad777b7537bf564bfefd`。在VPS独立核验完整ZIP、三份TAR、OCI/config及层摘要后导入。
- 三组件最终image ID（OCI manifest）：Core `sha256:5f4aa40e4d9acc693ec17144107cfa8e00aeddfb83d33ce070f86f3052d07907`；Bridge `sha256:8d107297b2f73be71c74475052ff77f150a3b62bf774749f094d5c85d8f005d5`；BFF `sha256:a3a3e3bffb8803523f65bffbf01a283ddf2660d04dd3295107b7a1bd7ae2c5a4`。config摘要继续见[固定清单](2026-10-19-admin-mobile-layout-evidence/candidate-manifest.json)。
- 实际Compose只更换三组件镜像；网络命名空间、挂载、环境指纹保持。PostgreSQL/Redis没有重启。三组件healthy，HTTPS与health/studio/video-studio及前端资源正常。
- 图片部署前true/true；Core重启后effective失效，按本轮授权通过官方管理员接口恢复为true/true。两次独立非付费检查均1870组合PASS，恢复接口服务端二次检查1870组合PASS。视频始终false/false，managed-v1不变。
- 商品/Account（含44、77）、售价、余额、usage/dedup、权限、receipt、任务绑定、历史素材保护指纹切换前后及浏览器验收后一致。无生成POST、无真实付费调用、无商品保存/发布。

## 备份与回退

新检查点 `/var/lib/ai-gateway/checkpoints/predeploy-b5b23-20261018T170043Z`，约281.5MB；完整性清单SHA256 `271603dc3b100f8adc18aad34b8e8e7eec5ecd35a67a5f814e54be9274ec099a`。隔离network=none、无生产挂载/公开端口恢复101表44,662行、217业务文件140,533,137字节及Redis RDB，PASS。初次验证缺少统一数据库会话时区，按既有Asia/Shanghai校正验证器后与同一快照完全匹配；未改生产数据。背景探测时间变化已与商品/资金变化区分。

旧b979三组件镜像与 `/var/lib/ai-gateway/candidate-transfer-b9796b975/compose.override.json`、旧检查点保留。新文件在 `/var/lib/ai-gateway/candidate-transfer-b5b23a1f0`。回退只恢复应用组件，禁止用旧数据库覆盖新业务；Core重启后必须重新独立验证付费有效状态。VPS导入后约23.45GiB可用。

## 真实生产浏览器结果

一次认证、一个上下文完成26项检查，24项PASS、2项测试断言失败，共24张真实生产截图；无pageerror。文生图/图生图/视频/历史在1440×900、1366×650、768×844、390×844、360×844均通过。已发布比例无滑块、现有原片解码与下载入口、继续创作、管理员readiness通过。截图来自部署后的laifufu.top；身份由上述运行容器与资源检查关联，不是fixture截图。

管理员Account77/44页面可读取，自定义比例、原生格式/视频时长入口检查已执行，但首个1440视口的编辑器宽度断言误要求至少1040px；真实既有 `.mw-editor-page` 最大宽度960px。截图符合该布局，不能据此认定应用回归。该断言抛错跳过后续管理员各视口、侧栏及价格/保存控件测试。因此这些项目仍未验收，不能用客户五视口或本地截图代替。

验收脚本断言已改为尊重960px上限；生产应用代码未变。本轮认证按完整测试结束规则已清除，不反复要求登录。尚需补齐修正后管理员五视口真实验收；不需重新部署，不因测试脚本误判回滚。

- [脱敏部署摘要](2026-10-19-admin-mobile-production-evidence/deployment-summary.json)
- [真实浏览器结果](2026-10-19-admin-mobile-production-evidence/browser-result.json)
- [1440桌面](2026-10-19-admin-mobile-production-evidence/text-1440x900.png)、[1366短屏](2026-10-19-admin-mobile-production-evidence/edit-1366x650.png)、[390手机](2026-10-19-admin-mobile-production-evidence/text-390x844.png)、[360历史](2026-10-19-admin-mobile-production-evidence/history-360x844.png)、[768视频](2026-10-19-admin-mobile-production-evidence/video-768x844.png)
- [管理员1440现场，顶部身份已遮罩](2026-10-19-admin-mobile-production-evidence/failure-admin-account-77.png)

修正验收断言后，本地模拟完整26项、48张截图PASS（加入960px编辑器上限），只证明执行通道，不冒充管理员生产复验。收尾C盘约4.52GiB、D盘约28.78GiB可用，本轮未清理磁盘；保留候选、回退和审计资产。
