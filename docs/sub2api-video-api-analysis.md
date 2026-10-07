# 视频任务 API 集成边界

本文保留通用协议与恢复要求，不包含具体供应商地址、采购报价、私有素材或部署账户。实际可用规格以精确 Account 的 Published 配置与适配器契约为准。

| 能力 | 协议示例 |
| --- | --- |
| 发现目录 | `GET /v1/models` |
| 初始化素材上传 | `POST /v1/media/uploads` |
| 查询素材上传 | `GET /v1/media/uploads/{id}` |
| 上传分片 | `PUT /v1/media/uploads/{id}/chunks/{index}` |
| 完成上传 | `POST /v1/media/uploads/{id}/complete` |
| 创建视频 | `POST /v1/videos`，携带 `Idempotency-Key` |
| 查询原任务 | `GET /v1/videos/{task_id}` |
| 取片 | `GET /v1/videos/{task_id}/content` 或契约指定的 `/download` |

这些是协议形状，不代表所有供应商均实现这些端点。标准状态包括 `queued`、`in_progress`、`completed`、`failed`；适配器负责准确映射。

创建前冻结 Account、Key、Published revision、adapter、规格、价格、成本和请求字节。网络中断或回执未知时查询原提交；只有明确的终态证据才能改变结算。完成后持久化并校验原片，再按冻结身份结算。

素材查询、上传和取片保持原身份。不得将 API Key 放入浏览器 URL 或跨域重定向。客户授权、供应商成本、报价与结算分别保存依据，并复用原生账本去重。
