# 场景示例

以下示例展示决策和命令结构。实际执行时使用当前 `Asia/Shanghai` 日期，不照抄示例日期。

## 五类正常查询

### 今日汇总

用户：“查询今天新增、活跃和启动数据。”

```bash
getui-cli api call statistics.today --input '{}'
```

成功后简要列出各维度的新增、活跃和启动数据及已有对比值，说明活跃采用接口默认的前台口径，再附完整 JSON envelope。

### 今日分时趋势

用户：“查看今天每小时活跃趋势。”

```bash
getui-cli api call statistics.period --input '{"metric":"active"}'
```

### 活跃统计

用户：“按平台查看昨日、周、月活跃。”

```bash
getui-cli api call statistics.activity --input '{"groupBy":"platform"}'
```

不传 `activityScope`，结果中说明采用默认前台活跃。

### 用户趋势

当前日期为 `2026-08-13`。用户：“查询最近 7 天 Android 和 iOS 的新增用户趋势。”

```bash
getui-cli api call statistics.userTrend --input '{"startDate":"2026-08-06","endDate":"2026-08-12","metric":"new","platforms":["android","ios"]}'
```

### 留存

当前日期为 `2026-08-13`。用户：“查询最近 7 天新增留存。”

```bash
getui-cli api call statistics.retention --input '{"startDate":"2026-08-05","endDate":"2026-08-11","metric":"new"}'
```

“最近 7 天活跃留存”和“最近 7 天启动留存”使用相同日期，分别生成 `metric: "active"` 和 `metric: "start"`。

用户明确查询 `2026-08-05` 至 `2026-08-11` 留存时允许调用；未指定类型时补充 `metric: "new"`。

用户查询截止 `2026-08-12` 的留存时，回答：“结束日期 2026-08-12 晚于当前最晚可查询日期 2026-08-11。昨天的次日留存需要今天结束后才完整形成，请将结束日期调整为 2026-08-11 或更早。”不要生成或执行 CLI 命令。

用户查询截止 `2026-08-13` 的留存时使用相同拒绝规则，不要生成或执行 CLI 命令。

用户：“查询 2026-07-01 到 2026-07-31 的留存。”

回答：“该范围包含 31 个自然日，超过留存查询 30 天上限。请缩短日期范围或拆分查询。”不要生成或执行 CLI 命令。

## 缺参和歧义

用户：“查询用户趋势。”

回答：“请提供日期范围，以及要查询的指标：新增、活跃、启动、累计用户、平均使用时长或平均使用频次。”不要执行 CLI。

用户：“查看今天每小时趋势。”

回答：“要查看哪项每小时趋势：新增用户、活跃用户还是启动次数？”不要执行 CLI。

用户只提供分组值 “Android”，但未说明按什么维度分组时，询问是否按平台分组；不要生成只有 `groupValue` 的调用。

## 默认口径

- 用户未说明留存指标：补充 `metric: "new"` 并说明默认新增用户留存。
- 用户未说明前台或全部活跃：不传 `activityScope` 并说明接口默认前台活跃。
- 用户明确说“包含后台”：传 `activityScope: "all"`。

## 错误处理

### 凭证缺失

提示用户在 CLI 环境中配置完整凭证或选择已有 profile。不要要求用户在对话中发送 App Key 或 Master Secret，也不要回显任何已知凭证。

### 鉴权失败

CLI 会对业务鉴权码 `10001` 强制刷新 Token 并重放统计请求一次。若最终仍返回 `GETUI_CLI_TOKEN_REJECTED` 或 `GETUI_CLI_HTTP_UNAUTHORIZED`，执行：

```bash
getui-cli status
```

仅说明 `credentialSource`、`secretStored` 和 `tokenStatus` 等诊断状态。提醒环境变量可能覆盖 profile，不显示 App ID、密钥或 Token。

### 权限或 IP 白名单

保留 CLI 错误码，提示检查个推控制台中的接口权限、VIP 权益或 IP 白名单。不要自动重试确定性的权限错误。

### 无数据或留存未成熟

空数组、`null` 或缺失留存窗口应说明接口未返回数据或窗口尚未成熟，不能替换为 0。

### 响应不兼容

若 `statistics.activity` 返回 `GETUI_CLI_RESPONSE_INVALID`，且字段对应远端 `"-"` 占位值，说明 CLI 未能兼容该响应字段。保留字段名和错误码，不根据残缺响应生成统计摘要。当前构建若已能将占位值规范化为 `null`，则按空值规则解释。

### HTTP 错误响应

CLI 的非 2xx 错误会在 `error.details.remoteResponse` 中保留经过脱敏和限长处理的服务端原始响应。例如服务端返回 `code: 20001` 和“超过允许时间跨度”时，如实展示这些诊断信息，同时保留 CLI 错误码；不要根据错误响应生成数据摘要。

## 超出范围

用户：“发送一条推送消息。”

回答：“`getui-statistics` 首版只支持五个只读统计查询，不支持发送推送。”不要执行 CLI 或直接调用 HTTP API。
