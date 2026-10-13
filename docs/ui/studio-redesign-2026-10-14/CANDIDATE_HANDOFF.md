# 作品桌最终运行候选交接（供 ChatGPT 审核）

状态：**CANDIDATE_READY_NOT_DEPLOYED**。仅准备和验收候选；未连接生产，未部署、启售或请求真实供应商。本文件是 Codex 实证报告，不替代正式根 Handoff。

## 冻结身份

- Core 运行源码：`40310e2961a5e8150e0c9df4cc86bb8087406c06`。
- 已审证据：`9783f0b7cf0d1bfdf771359b038cecfa1b333b94`；最近用户确认生产为 b2，未重新访问生产核实。
- 构建脚本：`b2914805ba6e9f3ebe9c716167e55153827b5969`。
- 最终验收脚本：`4f35d35d5cac7deaccddd5465b93bdaac709dd04`。
- Bridge/BFF 精确复用：`b2fcdac93afa6ae194ee81801a9b37813f8f39eb`；本次没有重建或重新导出它们。
- 脚本变化仅限现有 workflow/harness，运行代码没有超过冻结源码的修改。管理员成本换算、历史策略和媒体后端均未修改。

[最终 manifest](candidate-evidence/manifest.json) SHA-256：
`fe55c4ed2e5a11a9cf16cbbbc0cda5113fa4bc8fcbb43d94f2b66effbd8a306c`

## 三组件与归档

全部 `linux/amd64`。config digest / Image ID 与 OCI manifest digest 是不同对象，已从 TAR 的 config 内容及 OCI 引用分别校验。

### core（built）

- Source SHA：`40310e2961a5e8150e0c9df4cc86bb8087406c06`
- Image ID / config digest：`sha256:937d75ef1933a6278db3434dfd5992ec452ad79aa0bd84b8d978b4c927e41132`
- OCI manifest digest：`sha256:4226192373d58d843be944c82ef7f2c0940771c61a9c80a311df532eb4c59ef3`
- TAR：`core-40310e2961a5e8150e0c9df4cc86bb8087406c06.tar.gz`
- TAR SHA-256：`ada61c908172f1d6b7cc35b50979137ea85441c980157a3d1a0eefc72c8e0dec`
- 大小：61941931 bytes。

### bridge（reused）

- Source SHA：`b2fcdac93afa6ae194ee81801a9b37813f8f39eb`
- Image ID / config digest：`sha256:dd01aa29e152f589679e5065037459240aeb8ddfe3ec853c16033006fe67acda`
- OCI manifest digest：`sha256:caa90294c79db4253b8cdb97bb920a255afc9c3797555d0c18d55e6a7ffc9e25`
- TAR：`bridge-b2fcdac93afa6ae194ee81801a9b37813f8f39eb.tar.gz`
- TAR SHA-256：`30ba9310b18f1da057d9d7515d5d4eddea15c32077c234c848a2cbf36c9b4b35`
- 大小：19126414 bytes。

### bff（reused）

- Source SHA：`b2fcdac93afa6ae194ee81801a9b37813f8f39eb`
- Image ID / config digest：`sha256:e498b97225bfc15e286af26bff30ec5c8d84526adfdbcd8231ebf7bad50e3f21`
- OCI manifest digest：`sha256:cc7ae2120821e12ef687847408718bc2547c2f12ab9c05b2dd6609bb41e0344a`
- TAR：`bff-b2fcdac93afa6ae194ee81801a9b37813f8f39eb.tar.gz`
- TAR SHA-256：`29a1da9fa2ee0229cc352a0bbda2dbaa11735f80f291f65dc7f36a8dac6402f7`
- 大小：120269341 bytes。

完整候选本地归档：`D:/AI-Gateway-candidate-40310e296-final/`。此目录使用最终 PASS manifest；保留 `original-build-manifest.json` 作为原始构建记录，不改 TAR 字节。只下载一份完整包，不在本机加载、构建或导出镜像。旧 b2 归档与回退资产原样保留。[本地三份 TAR 和 OCI/config 复核](candidate-evidence/local-archive-verification.json)全部 PASS。归档后本机约 C:4.34 GiB、D:10.76 GiB 可用；本轮未清理共享缓存或回退资产，大型步骤全部在云端。

[构建 Run 38477125329](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38477125329)，完整 Artifact **11857055200**，有效至 **2026-10-27 22:27:08 UTC / 10-28 06:27:08 北京时间**。该原始包的验收标记是 NOT_PASSED，原因见下文；镜像构建和导出成功，最终补验使用完全相同 TAR。

[最终补验 Run 38478831552](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38478831552) **PASS**，小证据 Artifact **11857001668**，有效至 **2026-10-27 22:37:57 UTC / 10-28 06:37:57 北京时间**。最终部署身份以该证据包的 manifest 和本地最终归档为准。Actions 的14天产物不作为永久备份；本地完整归档及 Git 小证据已经保留。

## 复用与最终页面来源

[复用依据](candidate-evidence/reuse-proof.json)：逐项比对 b2 与403的 `backend/`、`studio/`、`deploy/studio/`、Dockerfile、忽略规则及许可打包配方 Git 对象，均相同。Bridge 只复制不带 embed 标签编译的 Bridge 二进制；前端只随 Core 发布。BFF 运行文件及合同未变。既有两个 TAR 的摘要、平台、revision 标签和完整 Image ID 均核对通过。

[组合配置](candidate-evidence/combination.json)是隔离启动关系摘要，**不是生产 Compose**。Core、Bridge、BFF 均 healthy，两个 sidecar 均附着本次 Core 的 network namespace；PostgreSQL/Redis 使用临时隔离状态。Core `/app/data`、BFF 素材/图片/视频目录按现有挂载工作。保留[运行文件摘要](candidate-evidence/runtime-files.json)及[组合验收记录](candidate-evidence/acceptance.json)。

浏览器只使用最终 Core 内置页面，经28100同源转发至28180 Core；不启动 Vite、不访问4295，不 mock 浏览器 API。`NATIVE_WORKSPACE_UI` 只选择新页面控件；开发代理改由独立 `NATIVE_WORKSPACE_DEV_SERVER` 开关控制，成品验收禁止该开关。36份实际页面 JS/CSS 资源已与直接 Core 响应逐字节核对，含工作台与管理员页面入口：[前端资源摘要](candidate-evidence/frontend-resources.json)。Chromium 因跳转丢弃的预加载响应不计入已核验资源，摘要明确保留此限制。

## 最终成品验收

真实浏览器 → 最终 Core/Bridge/BFF → 隔离数据库；仅供应商由现有模拟器替代。未复制真实账号或商品。

| 场景 | 交付 | 模拟生成请求 | 冻结/实收 CNY | 原生 usage/结算 | 刷新、查询、再下载 |
|---|---:|---:|---:|---:|---|
| 文生图 1K / 1:1 | 3张 | 3 | 0.70×3=2.10 | 1次 | 无新增 |
| 参考图编辑 1K / 1:1 | 2张 | 2 | 0.70×2=1.40 | 1次 | 无新增 |
| 普通兼容单视频 720p /16:9/5秒 | 1条 | 1 | 2.00 | 1次 | 无新增 |

报价确认前生成数、usage增量均为0；确认后才提交。图片实际上游参数保留分辨率和比例；编辑只附1份参考图；视频规格与请求一致、固定1条。每次原片下载和重复下载的摘要均与模拟器一致，视频实际播放时间前进。测试单价仅在隔离种子数据使用。

图片原片 SHA-256：`431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`。
视频原片 SHA-256：`9738ac5e6756d120b3a6805420362e31390b3b4a26b604dcacac86c660f72299`。

桌面1440px执行文生图/视频；390px执行参考图编辑全流程，并验证其他结果的手机查询。管理员图片/视频 Account 均检查顶部发布区、搜索不缩小 Account 发布范围、弹窗列出两份合成商品、取消不产生业务写入，以及返回模型列表。移动布局等待既有300ms响应式动画结束后检查，宽390/内容宽390/左边距0。管理员验收没有执行保存或发布，种子发布仅发生于隔离准备阶段。

[精简业务证据](candidate-evidence/acceptance-summary.json)。截图均已人工查看；未见稳定布局的水平溢出、重叠或关键控件遮挡。下列图片来自**最终候选**，不是旧咖啡视觉 fixture。黑色1×1 PNG、蓝色MP4为模拟器原片，不表示真实供应商画质。

- [桌面图片结果](candidate-evidence/native-artifact-image-result.png)
- [桌面金额确认](candidate-evidence/native-artifact-image-confirmation.png)
- [390px编辑结果](candidate-evidence/native-artifact-edit-result.png) / [手机金额确认](candidate-evidence/native-artifact-edit-confirmation.png)
- [单视频桌面](candidate-evidence/native-artifact-video-compatible-result.png) / [手机](candidate-evidence/native-artifact-video-compatible-mobile.png)
- [管理员顶部发布区](candidate-evidence/native-artifact-admin-image-desktop.png) / [手机](candidate-evidence/native-artifact-admin-image-mobile.png) / [Account范围及确认](candidate-evidence/native-artifact-admin-image-confirmation.png)

## 失败记录、CI 与门槛

首次 Actions 因 job env 使用不支持的 runner context 未通过解析，随后改用合法 workspace 位置；未改变运行代码。构建 Run 的图片业务已通过，但资源取证在导航后读取过期响应失败；补验使用同一镜像修正取证。随后管理员手机断言抓到响应式边距过渡帧；按源码300ms过渡等待稳定布局后全程通过。两次补验均无 docker build/save、无 TAR 重导出。不是删除业务校验或修镜像来取得 PASS。

- 冻结运行源码的[CI38472646408](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38472646408)、[Security38472646470](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38472646470)复用已通过证据。
- 最终脚本[CI38478831646](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38478831646)：PASS。
- 最终脚本[Security38478831661](https://github.com/maximeblen654-boop/AI-Gateway-public/actions/runs/38478831661)：PASS。
- 本地语法/YAML、禁止Vite冲突保护、归档config摘要正反例均PASS；大型构建、启动、浏览器和TAR导出全部在GitHub-hosted runner。

| 发布守卫 | 本轮适用性与结果 |
|---|---|
| ART-01 最终产物自身验证 | PASS：精确镜像＋内置页面＋真实隔离业务 |
| PUB-01/02/03/04 生产域名、边缘与缓存 | N/A：本轮禁止访问生产；不能由隔离PASS推定上线PASS |
| PUB-05 服务与功能 | 隔离范围PASS；生产切换后检查尚未授权 |
| PUB-06 失败证据/恢复 | 失败证据已保留；生产恢复资产现场核对N/A，未连接生产或执行回滚 |

## 交接边界

正式 Handoff58 已原样同步到 `D:/AI-Gateway/AI-Gateway-Handoff.md`，SHA-256为 `c76e48eb54a5ee5eec6cbf51dcf5f1e07e2a472485683f5fd79242d04c4f0a9d`；Constraints未改。D:/AI-Gateway 无关脏改动保留。

下一步仅等待用户针对上述确切组合的生产部署授权。本轮不做生产预检，不把隔离开启的测试销售/生成开关带到生产。没有生产数据库、账号、商品、价格或开关变更；没有生产商品发布、启售、真实供应商请求或实付测试。云端runner结束后隔离地址不可再访问。
