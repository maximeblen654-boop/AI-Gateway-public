# ac8923ab 生产部署准备：尚未切换

状态：`PREPARED_NOT_SWITCHED_AWAITING_IMAGE_RESTORE_AUTHORIZATION`。

本轮已获ac8923部署授权；授权同时明确禁止修改付费开关。实际代码 `StudioPaidControl.Status()` 按进程随机epoch校验已开启记录，Core重启后返回 `runtime_restarted`，图片实际关闭。`Apply()` 必须重新执行完整预检并写入新epoch才能恢复。d893→ac8923这段代码未变。不能通过保留环境或数据库enabled字段绕过。

已向用户请求一个限定补充：完整1870组合非付费预检通过后，仅恢复部署前图片开启状态；视频、Account销售标记不动，不生成。答复尚未收到，故没有切换容器，也没有执行该开关动作。

## 已完成

- SSH现场确认主机及d893整组三组件身份、健康、共享Core网络、挂载、managed-v1；登录会话确认图片实际开启、视频关闭。
- 迁移记录293条，候选无待迁移及checksum差异；Account #77当前保存1份商品。
- 本地最终PASS manifest SHA256 `e02049a204c85e801db1a643640caeb98747e9ede90dce50c61ab8ea8e38f232`、三个TAR、OCI/config交叉核验通过。三项指定GitHub验收/CI/Security状态重新只读确认success。
- 原配置和运行身份私密保存在 `/home/ubuntu/services/ai-gateway/deploy-funds-ops-ac8923-20261015/before/`；当前d893三镜像仍可恢复。
- 指定TAR已上传、远端复算及完整性通过、docker load完成；只准备三个镜像引用变化的overlay，没有应用。
- HTTPS管理员/客户入口及当前静态资源与Core逐字节核对通过；管理员会话可复用。
- 未重建镜像、未重启或切换服务、未执行迁移、未改商品/映射/价格/资金/付费开关、未调用供应商或真实任务恢复。

## 已加载但尚未运行的候选

运行源码：`ac8923ab666a77acc3675024c286ff2effff9546`；验收脚本：`6a3c6e3a0116829abe0364adb973ac7ccc529fce`。

- core config/Image ID：`sha256:24c6fdf42705d35c9736c526b052efd5a9a6af964e8c3868725d86cfae2b7690`；OCI：`sha256:e78166bf05b68299c9bd839ab5431ff051d02def730165d9f492ddca1097b7e2`；TAR SHA256：`19adcc3908ab51e7796d56dd481a27575d3b7657479d293bb5648cf5ca82e13e`。
- bridge config/Image ID：`sha256:b3c86c854a915e977496ab78db7ed8bae8380c371aa24c8f2e63803abc07fad4`；OCI：`sha256:65142a7635c34b2c6675117ed0870e93acbd977363a2fcfac021a3598273b242`；TAR SHA256：`8ca90d6c31a2f9895fe410b6fae7b5a4d0cb3d58277a9966773cbc6a2b92f800`。
- bff config/Image ID：`sha256:85380819444bab8bafac475cb867f6a05ada90ec09c5dca189b8365cde294a6d`；OCI：`sha256:fbe06459ecd03646a3bea837ff10ebcdf540c5ff4a5aafb803b29d680b696836`；TAR SHA256：`9a3802a7790dfb93b4c7210be3474fdc7850ae147bff2d72a93642d2622735bc`。

准备结束时间（UTC）：`2026-10-15T02:15:47.371876+00:00`；VPS可用约10.32 GiB。

待应用overlay：`/home/ubuntu/services/ai-gateway/deploy-funds-ops-ac8923-20261015/compose.override.ac8923ab.json`，SHA256 `df5f5dd8ec85ec62463eb026fa0b8bc66e1c74570d945e44d8c5136974432cde`。它仅改变三组件镜像，无环境变化。

最终生产非付费报价、1870组合、候选页面与切换后保护指纹尚未执行，不用准备成功代替部署成功。确认限定开关恢复授权后须先核对基线未漂移，再切换、预检、恢复图片及最终验收。原生迟到首次结算与负余额合同未修改。
