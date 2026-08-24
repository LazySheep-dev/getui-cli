# Operation 契约

只允许调用下表中的 14 个已注册 operation。不要根据用户输入构造 URL、HTTP 方法、请求头或未列出的 operation。默认入口是：

```bash
getui-cli api call <operation> --input '<JSON>'
```

若使用 profile，放在根命令选项位置：`getui-cli --profile <alias> api call ...`。

用户向量接口以个推官方用户 API 文档为准：[用户 API](https://docs.getui.com/ido/server/user/)。

## 标签 operation

### `tag.user`

用途：查询一批用户的标签。

输入：`userIdList`，非空字符串数组，1-200 项；保留用户提供的 ID，不生成或转换 GTCID。

```bash
getui-cli api call tag.user \
  --input '{"userIdList":["gtcid-example-1","gtcid-example-2"]}'
```

只读，不需要 `--yes`。

### `tag.tree`

用途：查询应用完整标签树。输入必须是空对象。

```bash
getui-cli api call tag.tree --input '{}'
```

只读，不需要 `--yes`。

### `tag.external.create`

用途：创建自有标签。

输入：`name` 和至少一个 `tagValueList`；可选 `dirId`、`description`。标签值含 `tagValCn`，`idType` 可选：`mobile_md5`、`imei_md5`、`oaid_md5`、`idfa_md5`、`cid`、`gtcid`。

```bash
getui-cli api call tag.external.create \
  --input '{"name":"VIP用户","description":"示例标签","tagValueList":[{"tagValCn":"黄金用户","idType":"gtcid"}]}' \
  --yes
```

写操作，必须先向用户展示确认摘要。

### `tag.external.edit`

用途：编辑已有自有标签。

输入：`tagCode`、`name` 和至少一个标签值；已有标签值提供 `tagValCode`，新增标签值必须显式 `reset: true`。

```bash
getui-cli api call tag.external.edit \
  --input '{"tagCode":"tag-example-1","name":"VIP用户-新版","tagValueList":[{"tagValCn":"黄金用户","tagValCode":"value-example-1","reset":false},{"tagValCn":"新用户","idType":"gtcid","reset":true}]}' \
  --yes
```

写操作，必须先向用户展示确认摘要。

### `tag.external.import`

用途：向已有标签值导入用户 ID。

输入：`tagValCode` 和 1-200 项非空 `idList`。

```bash
getui-cli api call tag.external.import \
  --input '{"tagValCode":"value-example-1","idList":["gtcid-example-1","gtcid-example-2"]}' \
  --yes
```

写操作，不能自动拆分 201 条以上的列表。

### `tag.external.trigger`

用途：触发一个或多个自有标签计算。

输入：非空 `tagCodeList`。

```bash
getui-cli api call tag.external.trigger \
  --input '{"tagCodeList":["tag-example-1"]}' \
  --yes
```

写操作，必须先向用户展示确认摘要。

## 用户导入 operation

### `user.import.event`

用途：导入历史事件埋点数据。

输入：`dataList` 1-200 条。每条必须含非空 `gtcid`、13 位毫秒时间戳字符串 `datetime`、非空 `eventId` 和 `properties`；可选 `sessionId`。`properties.$app_type` 只能是 `app`、`mp`、`h5`，且必须含非空 `properties.$os`。

```bash
getui-cli api call user.import.event \
  --input '{"dataList":[{"gtcid":"gtcid-example-1","datetime":"1712646657000","eventId":"launch","properties":{"$app_type":"app","$os":"android"}}]}' \
  --yes
```

批量文件：

```bash
getui-cli api call user.import.event --input-file ./event-import.json --yes
```

写操作，Skill 不补造记录、不把秒时间戳转换为毫秒，也不自动拆批。

### `user.import.user`

用途：导入历史用户埋点数据。

输入：`dataList` 1-200 条。每条必须含 `gtcid`、13 位毫秒时间戳字符串 `datetime` 和合法 `properties`；不接受事件专有字段。

```bash
getui-cli api call user.import.user \
  --input '{"dataList":[{"gtcid":"gtcid-example-1","datetime":"1712646657000","properties":{"$app_type":"app","$os":"android","level":"3"}}]}' \
  --yes
```

写操作，成功摘要只显示服务端结果和导入类型/数量，不回显完整记录。

## 用户群 operation

### `user.crowd.list`

```bash
getui-cli api call user.crowd.list --input '{}'
```

只读。保留服务端返回的用户群 ID、名称、人数、完成时间和总数（若接口返回）。

### `user.crowd.export.create`

输入：`crowdId` 和大小写敏感的 `uidType`，只允许 `CID` 或 `GTCID`。

```bash
getui-cli api call user.crowd.export.create \
  --input '{"crowdId":"CROWD_example","uidType":"GTCID"}' \
  --yes
```

写操作。创建后只返回 task ID，不自动查询状态。

### `user.crowd.export.status`

输入：`crowdId` 和正安全整数 `taskId`。

```bash
getui-cli api call user.crowd.export.status \
  --input '{"crowdId":"CROWD_example","taskId":1001}'
```

只读。保留状态和成功时的 `fileIdList`。

### `user.crowd.export.file`

输入：`crowdId`、正安全整数 `taskId` 和非空 `fileId`。

```bash
getui-cli api call user.crowd.export.file \
  --input '{"crowdId":"CROWD_example","taskId":1001,"fileId":"file-example-1"}'
```

只读。JSON 输出保留完整 ID 列表；默认摘要不展开大列表。

## 用户向量 operation

### `user.vector.query`

用途：查询一个 GTCID 的用户向量。

官方路径：`POST /v2/query_vector`。

输入：一个非空 `userId`，必须是用户已提供的真实 GTCID。人工调试入口将 `--gtcid` 映射为 `userId`：

```bash
getui-cli user vector query --gtcid gtcid-example-1
```

```bash
getui-cli api call user.vector.query \
  --input '{"userId":"gtcid-example-1"}'
```

只读，不需要 `--yes`。服务端返回的 `vert` 是不透明字符串，Skill 不解析或转换。

### `user.vector.batch`

用途：批量查询多个 GTCID 的用户向量。

官方路径：`POST /v2/batch_query_vector`。

输入：`userIdList`，1-50 个非空 GTCID；保留输入顺序，不去重，不自动拆批。人工调试入口支持行内 JSON、文件和非 TTY stdin：

```bash
getui-cli user vector batch \
  --input '{"userIdList":["gtcid-example-1","gtcid-example-2"]}'

getui-cli user vector batch --input-file ./vector-users.json
```

```bash
getui-cli api call user.vector.batch \
  --input '{"userIdList":["gtcid-example-1","gtcid-example-2"]}'
```

超过 50 个 ID 在本地拒绝且不发请求。成功响应中的 `validVectors`、`invalidVectors` 和 `vert` 原样保留。该接口可能要求 VIP 权限，权限错误按 CLI envelope 原样处理。

## 调用规则

- 正常查询默认 JSON，不加 `--format`、`--raw` 或 `--debug`。
- 读取文件时使用 `--input-file`，不要同时提供 `--input` 或 stdin。
- 写操作的 `--yes` 只能在 Skill 获得明确确认后添加。
- 未知 operation、任意 URL、任意方法和自定义请求头一律拒绝。
