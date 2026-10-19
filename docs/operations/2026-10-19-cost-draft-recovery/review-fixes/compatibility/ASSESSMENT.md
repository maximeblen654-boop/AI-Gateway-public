# save_receipt 旧版兼容与回退独立结论

2026-10-19。状态：`P0_DEPLOYMENT_BLOCKED`。兼容 Core 仅为 `PROPOSED / NOT_BUILT / NOT_DEPLOYED`。

源码范围：`D:/AI-Gateway-public-staging`，HEAD `33c819064ef95666f6b512ebaed1e2d7a09e34d6` 加当前未提交修改；旧基线为 `8ad2eff39ff5bf6bfd07563041556f4a4c42d9a1`。本目录只新增脱敏验证脚本、结果与结论，没有修改业务源码、提交、推送、构建应用候选、连接生产或付费调用。

## 已证实的兼容断点

1. 旧 `media_config_repo.go:52-62` 对整个 `media_workbench_v1` 使用 `DisallowUnknownFields`。旧 `Draft` 不含 `save_receipt`，实测新 JSON 及 `"save_receipt":null` 均报 `json: unknown field "save_receipt"`。生产 reader 会返回 `unsupported media configuration schema`，不会退回旧格式或跳过字段。
2. 旧 `media_workbench_handler.go:92-104,137-145` 同样严格解码；新前端顶层 `submission_id` 在进入 `SaveDraft` 前被拒绝，按 `ErrInvalid` 为 HTTP 400。字段在数据库尚未出现时，也不能先上线新前端。
3. 旧/当前 repo 的 CAS 都先 `json.Marshal(Config)`，再整体替换 `extra.media_workbench_v1`（`media_config_repo.go:184-199`）。仅去掉 `DisallowUnknownFields` 会让旧 typed reader 读后写回时丢掉回执；隔离探针实测了此丢失。这个改法不可作为兼容桥。
4. `List` 任一 Account 解码失败即整次失败（同文件 `167-181`）。`Suppliers`、图片 Catalog 和视频 Catalog 都依赖此列表（`media.go:273-276`、`studio_image_runtime.go:55-59`、`studio_video_runtime.go:36-43`）；影响范围可能超过被保存的单个 Account。报价后的 Account 再核对也依赖 `Get`（`studio_image_account.go:33-39`）。这是源码调用链结论，未声称运行镜像已复现。
5. 普通 Account 更新有独立保护：`account_repo.go:671-730` 在行锁下取出当前 JSON 并原样放回；`stripMediaConfigExtra` 禁止通用更新替换 CAS 文档。不能由媒体 reader 失败推断普通 API 中转一定失败，也不能用普通 Account 更新成功证明媒体 reader 兼容。

当前与旧基线的 repo 文件完全相同；旧基线与 HEAD 在本次涉及的 `media.go`、handler、API 和 composable 也无差异。兼容差异来自尚未提交的新增 receipt/保存确认实现。

## 源码协议矩阵

`D0` 指没有 `draft.save_receipt` 键；`D1` 指存在该键（包括 null）。`F0/B0` 为旧 8ad UI/Core，`F1/B1` 为本次工作区 UI/Core。

| 前端 / 后端 / 数据 | 结果与边界 |
|---|---|
| F0 + B0 + D0 | 原协议可用；旧确认算法没有本次 submission 归属保证 |
| F1 + B0 + D0 | 新 PUT 在严格输入解码处 400；不能前端先行 |
| 任意 F + B0 + D1 | 配置 Get/List 失败；禁止以旧整镜像回退 |
| F0 + B1 + D0/D1 | 读取兼容，老请求也能进入保存；成功保存会生成新 draft，并不生成本次 receipt。旧 UI 不能提供新 UI 的提交归属确认保证 |
| F1 + B1 + D0/D1 | 结构与请求兼容；新写原子生成 receipt，新 UI 按 ID/base/revision/内容核对。这里只证明源码结构与序列化，不代替完整应用/镜像验收 |
| F0/F1 + 拟议兼容 Core | 尚无产物/完整集成结果，`UNKNOWN`；不得写为已验证回退可用 |

正常的后续草稿保存可以使上一份 receipt 失效。当前 `media.go:529-531` 及 `save_receipt_test.go:83-101` 的无 ID 新草稿行为属于此语义，不应把旧 receipt 复制到新 draft 假冒确认。禁止的是为让 B0 读取而擦字段、降级整份 JSON 或恢复旧数据库。需要保留回退时尚待确认的已存草稿，则优先只读，不让无 ID 的旧 UI 覆盖它。

## 最小兼容 Core 与顺序（仅方案）

兼容 Core 是从已接受基线保留媒体既有行为、回移 receipt 边界修复的同一个 Core，不新增存储系统、不更改持久化字段。不能只放宽 decoder。最小 backport 内容为：

- `Draft.SaveReceipt` 与 `SaveReceipt` 的三个 typed 字段；保留严格 reader 与 `omitempty`，兼容旧文档缺字段。
- handler 顶层 `submission_id`、ID 格式校验、CAS 中草稿与 receipt 原子写入；保留本次 `sameSavedDraft` / confirmation conflict 修复，避免返回别人的 DTO 作为本次确认。
- 非草稿 mutation（validation、selected publish、sales、lifecycle）完整保留当前 Draft/receipt。用 repo/事务测试验证所有写入口，不靠单次 DTO round-trip 替代。
- 如需要支持旧 UI 回退且保护待确认草稿，可在 `SaveDraft` 完成读取及版本核对后、任何内存/持久化修改前增加如下 guard；这是 `PROPOSED`，未在业务源码实现：

```go
if input.SubmissionID == "" && a.Config.Draft.SaveReceipt != nil {
    return nil, ErrClientUpgradeRequired // 明确 409；当前输入和服务器草稿保留
}
```

上述 guard 使该情形下旧 UI 的保存受控拒绝，不构成旧 UI 完整读写兼容；不能称为零影响回退。若回退目标是媒体管理只读，应验证并封闭全部 mutation 入口，不能只隐藏按钮或只靠这个 guard。当前没有已验收的统一只读机制，尚不能声称该回退模式可直接启用。

后续获得候选构建/发布授权后，顺序应是：

1. 先完成兼容 Core 的源码、测试及固定摘要的镜像，并准备“兼容 Core + 旧 UI”的回退组合；用隔离新文档验证其读取和写入保留，再允许其成为回退目标。
2. 先切兼容 Core，继续旧 UI，并核对实际运行摘要与功能；旧 Core 实例全部退出，不能在共享数据库中混跑 B0 和会产 receipt 的实例。
3. 再切新 UI（其承载 Core 也须兼容）。第一份新 receipt 持久化后，最低回退 Core 必须保持兼容。先停止并核对管理写入/在途保存，再回旧 UI 的受控只读组合；保留浏览器本地恢复副本。

本仓库发布形态将 UI 嵌入 Core：根 `Dockerfile:90-105`、`deploy/Dockerfile:67-79` 与 `backend/internal/web/embed_on.go:29-30`。因此“前端单独回退”是协议方案，必须有已验证的独立静态资产路由，或重新组合的“兼容 Core + 旧 UI”不可变镜像。直接换回旧 8ad 镜像会同时回退 Core，不属于前端单独回退。

现有 `data/public` 局部 override 也不能直接视为完整 UI 回退通道：当前 Middleware 对 index/SPA 先返回嵌入 HTML（`embed_on.go:102-105`），仅嵌入 dist 已存在的静态路径再尝试 override（`108-110`）。尚未验证旧 UI 不同 hash 资产及 index 的完整切换，不据此宣布 UI 可独立回退。

## 可重复本地证据

执行（仅 Python、已有 Go 标准库、已有本地 Git 对象，不下载依赖）：

```powershell
python D:/AI-Gateway-public-staging/docs/operations/2026-10-19-cost-draft-recovery/review-fixes/compatibility/probe_strict_schema.py
```

`probe_strict_schema.py` 用 `git show 8ad...:<path>` 取不可变旧源码，对比当前工作树源码，原样提取 `Config` / `DraftInput` 的全部传递数据类型及内嵌 `imageplan.Plan` / `AssetSlot`、handler 中实际的请求 struct、实际 `makeDraft`。只去掉请求类型的包限定名，不重命名字段，不改 JSON tags；断言两边实际生产 reader 均保留严格 decoder/EOF 合同。

两个临时小型 Go 模块在仓库外 `D:/receipt-compat-review-*` 执行同一组合成 JSON fixture；测试完成即清理。未编译/导入应用包，未运行数据库或 HTTP 服务，未测试运行镜像。脚本不保存任何真实 Account 配置。

实际工具链：`go version go1.27.0 windows/amd64`（不冒认为项目 Go 1.27.2 应用测试）。结果 `probe-results.json`：旧结构 10/10、当前结构 11/11，退出码均 0。通过项包括“预期拒绝旧版不识别字段”以及“预期宽松旧结构丢回执”，不是 21 个跨版本兼容 PASS。

结果逐文件记录旧 Git blob、raw/normalized SHA256、实际提取的类型/请求/函数 SHA256、生成探针 SHA256、fixture SHA256、实际结果与清理状态。全文件摘要与 normalized 摘要分别保留以辨别 CRLF，不把工作树摘要当成新 Git SHA。

已可证明：旧 schema/read/request 的不兼容、新 typed schema 读取旧文档、取消 strict 后旧型写回丢 receipt、当前 typed 非草稿 round-trip 保留 Draft，以及无 ID `makeDraft` 新建 draft 的语义。

仍缺最小证据：兼容 Core 的实际 backport、覆盖全部 writer 的 SQL/HTTP 集成与交叉版本测试、兼容 Core/旧 UI 组合及新组合的固定镜像摘要与回退演练。没有不可变兼容产物时，`P0_DEPLOYMENT_BLOCKED` 不能解除；保持现行部署，不擦字段、不回滚整库。

空间：探针开始 C 5.16 GiB / D 22.76 GiB 可用；本次复核结束 C 5.15 GiB / D 22.22 GiB 可用。临时探针已全部删除，只保留本目录约 38 KiB 的证据，不清理共享 Go 缓存。并行任务也会改变总量，本轮未执行磁盘清理，不把盘差额冒认清理释放量；最终空间由主执行者统一记录。
