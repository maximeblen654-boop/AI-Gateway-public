# 图片开启前检查：完整规格校验性能修复

状态：CANDIDATE_READY_NOT_DEPLOYED。最终同镜像验收已通过，完整结果与固定身份见 [执行交接](HANDOFF.md)。

## 事实与边界

生产基线 c6af2299086831f99a40b045b889ce72573aadc2，现场旧证据见 ../2026-10-15-paid-controls/DEPLOYMENT.md；本轮没有连接生产。
旧路径对每个规格调用 ResolvePublishedImageOffer，再进入 publishedReady → Validate，导致 N 个规格被全量编译 N 次。

合成同形输入：4K × 11 比例 × 1～10 张 × 0～16 参考图 = 1,870。未减少规格，未改价格合同或 Axios 30,000ms。
Windows Go 1.27.0 实测（非生产）：

|阶段|旧循环|请求内批量检查|
|---|---:|---:|
|枚举/完整校验|39.7243ms|41.1443ms|
|每项解析及重复完整校验|123657.6518ms|不再重复|
|逐项解析/编译|169.7900ms|127.1226ms|
|总计|123867.1661ms|168.2669ms|

命令：`STUDIO_PREFLIGHT_BASELINE=1 go test ./internal/mediaworkbench -run '^TestPreflight1870LegacyTiming$' -count=1 -v`（环境变量按 shell 设置）；优化检查 `go test ./internal/mediaworkbench -run TestPreflight -count=1 -v`。
该对照仅测纯本地规格路径，不将其冒充完整 HTTP 预检或生产性能。

## 实现

InspectPublishedOffers 在一次同步调用内完整验证当前仓储快照，再复用原来的私有单规格解析和编译实现遍历全部合法组合。没有跨请求缓存、可重用 PASS 或公开跳过校验的解析器。
正常客户报价仍走原公开解析入口。原生非付费报价、权限、额度、成本及存储检查保留；检查结束、开启动作写入前继续重新读取依赖指纹。草稿不替代 Published。
完整校验和编译循环响应 context 取消；取消/超时不得授权开启。管理员报告新增脱敏汇总 metrics（规格数、Account 数及阶段耗时），不包含凭据或路由。

## 最终产物验收

复用 native-media-candidate / paid-controls 场景。保留文生图、参考图编辑、单视频、原片摘要、下载、一次结算、权限拒绝、配置失效和 sidecar 故障回归。
额外 scale 阶段在真实隔离数据库保存发布同形 1,870 规格商品，最终 Core 页面执行三次“开启前检查”和一次确认开启；每次必须完整覆盖 1,870，页面到结果小于15秒，视频不串开，模拟供应商计数不变，最终两种提交都关闭。
大型构建仅在 GitHub-hosted runner，本地不构建镜像。最终结果和指纹见上述执行交接；未部署生产。
