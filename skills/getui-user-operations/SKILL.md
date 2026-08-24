---
name: getui-user-operations
description: "通过现有 getui-cli 以自然语言查询和管理个推标签、用户数据、用户群与用户向量，覆盖标签查询和维护、历史数据导入、用户群导出、GTCID 获取指引及向量查询。当用户询问这些能力或需要将自然语言转换为个推用户 operation 时使用；统计查询交由 getui-statistics。"
---

# Getui User Operations

通过已安装的 `getui-cli` 将自然语言请求转换为固定的标签或用户 operation。复用 CLI 的凭证、Token、HTTP、重试、Schema 和脱敏能力，不直接访问个推 HTTP API。

## 能力边界

只处理以下 14 个 operation：

- 标签：`tag.user`、`tag.tree`、`tag.external.create`、`tag.external.edit`、`tag.external.import`、`tag.external.trigger`
- 用户：`user.import.event`、`user.import.user`、`user.crowd.list`、`user.crowd.export.create`、`user.crowd.export.status`、`user.crowd.export.file`
- 向量：`user.vector.query`、`user.vector.batch`

统计请求交由 `$getui-statistics`。推送、任意其他 API、profile 管理和移动端 SDK 集成不属于本 Skill。

## 按需读取参考资料

- 读取 [references/operations.md](references/operations.md) 选择 operation、核对字段、枚举和调用模板。
- 读取 [references/safety-and-semantics.md](references/safety-and-semantics.md) 处理 GTCID、隐私、确认、导出流程和错误语义。
- 读取 [references/examples.md](references/examples.md) 处理缺参、复杂写操作、鉴权失败和能力边界场景。

## 工作流

1. **识别意图。** 区分标签查询/维护、历史用户数据、用户群导出、用户向量和统计请求；统计请求转交 `$getui-statistics`。
2. **选择一个 operation。** 不能根据输入构造新 operation、URL、HTTP 方法或请求头。意图或分组不明确时只询问相关歧义。
3. **收集参数。** 读取 operation reference，要求用户提供必填字段和完整 JSON。不要生成 GTCID、时间戳、事件 ID、属性、标签代码、task ID 或文件 ID。
4. **本地检查。** 在调用 CLI 前检查枚举、空值、数量上限、`reset` 规则、13 位毫秒时间戳和 `$app_type`/`$os`。发现错误时指出字段并停止。
5. **判断副作用。** `tag.external.*`、两种 `user.import.*` 和 `user.crowd.export.create` 是写操作；向量查询是只读；写操作先展示确认摘要，未获明确确认不得读取凭证、取得 Token 或执行 CLI。
6. **执行固定命令。** 使用默认 JSON 输出：

   ```bash
   getui-cli api call <operation> --input '<JSON>'
   ```

   写操作在确认后追加 `--yes`；用户提供文件时使用 `--input-file`。不默认添加 `--raw`、`--debug` 或 `status`。
7. **处理结果。** 仅在 `ok: true` 时总结成功数据；先给简短客观摘要，再按需保留结构化 envelope。空数组、`null` 或缺失字段表示接口未返回数据，不解释为零。
8. **处理失败。** 保留 CLI 错误码、阶段、可重试性和脱敏后的远端信息。CLI 鉴权刷新/重放仍失败时才运行 `getui-cli status`，只说明凭证来源和 Token 状态。

## 写操作确认

确认摘要至少说明：operation、目标标签或用户群、记录/ID 数量、将产生的远端变化。用户只说“帮我处理”或“执行一下”不算确认；需要明确的“确认”“执行”“是”等答复。

确认只覆盖当前一步。不要因为用户要求“导出用户群”就自动创建任务、轮询状态或下载文件；按列表、创建、状态、文件四步分别执行。

## GTCID 规则

GTCID 是 IDO 客户端 SDK 生成的用户标识，不是 App 凭证、Token、CID 或业务 `userId`。不从任何其他值推导、哈希或猜测 GTCID；用户没有提供真实 GTCID 时，只说明获取方式并请求其从客户端或业务库提供。

用户询问获取方式时，读取 `safety-and-semantics.md`，说明 Android、iOS、H5/小程序和鸿蒙的 SDK 入口。不要调用 CLI，也不要要求用户在对话中发送 App Key、Master Secret 或 Token。

## 输出与安全

- 默认使用 CLI 的 JSON envelope；不回显凭证、签名、Token 或完整 App ID。
- 导入成功只展示 `code`、`msg`、导入类型和记录数，不展开完整 `dataList`。
- 文件查询默认展示文件数量；只有用户明确要求时才展开完整 ID 列表。
- 用户明确要求原始服务端响应时才加 `--raw`，并保留 CLI 脱敏结果。
- 向量查询默认只摘要查询数量、有效/无效数量和向量是否存在；只有用户明确要求时才展开完整 `vert` 字符串。
- 不把用户 ID 或 GTCID 写入 profile、缓存或 Skill 文件；确认和诊断中尽量使用数量或掩码。

## 超出范围

对统计、推送、任意 URL、未知 operation、自动批量拆分、自动导出下载或 SDK 编程请求，明确说明当前 Skill 不支持，不生成 CLI 或 HTTP 请求，并在统计场景提示使用 `$getui-statistics`。向量批查超过 50 个 GTCID 时直接拒绝并要求用户自行拆分。
