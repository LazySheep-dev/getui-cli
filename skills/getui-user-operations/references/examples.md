# 场景示例

示例中的 ID 都是合成值。实际执行前使用用户提供的真实 operation 参数；写操作示例需要单独确认。

## 标签查询

用户：“查询 gtcid-demo-1 和 gtcid-demo-2 的标签。”

```bash
getui-cli api call tag.user \
  --input '{"userIdList":["gtcid-demo-1","gtcid-demo-2"]}'
```

只读，直接执行。摘要报告有效/无效用户数量和接口返回的标签数据。

用户：“查看应用完整标签树。”

```bash
getui-cli api call tag.tree --input '{}'
```

## 标签写操作

用户：“创建一个 VIP 标签，包含黄金用户标签值。”

先询问：

```text
将创建 tag.external.create：标签名“VIP”，新增 1 个标签值；该操作会修改远端标签配置。确认执行吗？
```

用户明确确认后：

```bash
getui-cli api call tag.external.create \
  --input '{"name":"VIP","tagValueList":[{"tagValCn":"黄金用户","idType":"gtcid"}]}' \
  --yes
```

编辑、导入和触发同样先确认，再分别调用：

```bash
getui-cli api call tag.external.edit \
  --input '{"tagCode":"tag-demo-1","name":"VIP-新版","tagValueList":[{"tagValCn":"黄金用户","tagValCode":"value-demo-1","reset":false}]}' \
  --yes

getui-cli api call tag.external.import \
  --input '{"tagValCode":"value-demo-1","idList":["gtcid-demo-1"]}' \
  --yes

getui-cli api call tag.external.trigger \
  --input '{"tagCodeList":["tag-demo-1"]}' \
  --yes
```

如果编辑输入新增标签值但没有 `reset: true`，先指出该字段，不调用 CLI。

## 历史数据导入

用户提供完整 JSON 后，先报告记录数量并确认：

```text
将向 user.import.event 导入 1 条历史事件，包含用户标识和属性，确认执行吗？
```

确认后：

```bash
getui-cli api call user.import.event \
  --input-file ./event-import.json \
  --yes
```

行内最小示例：

```bash
getui-cli api call user.import.user \
  --input '{"dataList":[{"gtcid":"gtcid-demo-1","datetime":"1712646657000","properties":{"$app_type":"app","$os":"android"}}]}' \
  --yes
```

没有 `gtcid`、13 位 `datetime`、事件 ID、`$app_type` 或 `$os` 时只追问缺失字段。201 条记录直接拒绝，并建议用户自行拆分后再次明确提交；Skill 不自动拆分。

## 用户群导出

用户：“列出可以导出的用户群。”

```bash
getui-cli api call user.crowd.list --input '{}'
```

用户选定群组后，先确认创建任务：

```text
将为用户群 crowd-demo 创建 GTCID 导出任务，可能产生远端任务和文件。确认创建吗？
```

确认后：

```bash
getui-cli api call user.crowd.export.create \
  --input '{"crowdId":"crowd-demo","uidType":"GTCID"}' \
  --yes
```

拿到 task ID 后，用户再次提出查询请求才执行：

```bash
getui-cli api call user.crowd.export.status \
  --input '{"crowdId":"crowd-demo","taskId":1001}'
```

状态成功并提供 file ID 后，再执行：

```bash
getui-cli api call user.crowd.export.file \
  --input '{"crowdId":"crowd-demo","taskId":1001,"fileId":"file-demo-1"}'
```

不要在创建后自动轮询、下载、遍历文件或合并列表。

## GTCID 咨询

用户：“怎么获取 GTCID？”

不调用 CLI。说明 GTCID 由 IDO 客户端 SDK 生成：Android 使用 `IGtcIdCallback.onGetGtcId`，iOS 使用 `GTCountSDKDidReceiveGtcid` 或 `GTCountSDK.gtcid`，H5/小程序在 SDK 启动后调用 `GsIdo.gtcid()`，鸿蒙读取 `Ido.init(context)` 返回值。不要声称可以从 App Key 或 Token 计算 GTCID。

## 缺参和边界

用户：“导入历史事件。”

只追问 JSON 或 JSON 文件路径，以及缺失的必要记录字段；不生成示例数据并执行。

用户：“把 201 个 ID 导入标签。”

回答超过 CLI 允许的 200 条上限，不能自动拆分；不发请求。

用户：“查询最近七日留存。”

说明这是统计请求，交由 `$getui-statistics`，不调用本 Skill 的用户 operation。

## 用户向量查询

用户：“查询 gtcid-demo-1 的用户向量。”

```bash
getui-cli api call user.vector.query \
  --input '{"userId":"gtcid-demo-1"}'
```

只读，直接执行。正文先摘要向量是否存在和服务端状态，不默认展开完整 `vert`。

用户：“批量查询 gtcid-demo-1、gtcid-demo-2 的向量。”

```bash
getui-cli api call user.vector.batch \
  --input '{"userIdList":["gtcid-demo-1","gtcid-demo-2"]}'
```

列表最多 50 个 GTCID；超出时直接拒绝并要求用户自行拆分，不自动发多次请求。

用户提供 JSON 文件时：

```bash
getui-cli api call user.vector.batch --input-file ./vector-users.json
```

用户提供 51 个 GTCID 时，不运行 CLI；说明批查上限为 50，要求用户自行拆分后重新提交。

服务端返回 `vert: ""`、`null` 或缺失时，摘要为“接口未返回可用向量”，不能展示或推断为零向量。

服务端返回 VIP 未开通时，保留 CLI 的 `permission` 类型、错误码、远端 `code`/`msg` 和 `retryable`，提示检查个推 VIP 权益或联系技术支持。

用户明确说“展开完整向量”时，才从结构化 envelope 展示原始 `vert`；仍不得展示凭证、Token 或签名。

用户：“查询这个业务 userId 的向量。”

先说明 CLI 只接受个推 SDK 产生的真实 GTCID，不从业务 userId、CID 或凭证推导，并请求用户提供 GTCID。

用户：“发送推送。”

说明本 Skill 只支持标签和用户 API，不支持推送，不构造其他 CLI 或 HTTP 请求。

## 错误处理

### 鉴权失败

CLI 会先按自身策略刷新 Token 并重放一次。最终仍返回鉴权错误时运行：

```bash
getui-cli status
```

只报告 `credentialSource`、`secretStored` 和 `tokenStatus`，不回显任何凭证。

### 权限或 VIP

保留 CLI 错误码和远端 `code`/`msg`，提示检查个推控制台的接口权限、VIP 权益或 IP 白名单，不把失败说成成功。

### 空数据或响应异常

空数组、`null` 或缺失字段表示接口没有返回可用数据。若 CLI 报告字段不兼容，保留错误码和字段名，不根据残缺结果生成摘要。
