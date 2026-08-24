# Operation 契约

只允许调用下表中的五个 operation。不要根据用户输入构造 URL、HTTP 方法或其他 operation。

| 用户意图 | Operation | 必填字段 | 可选字段 |
| --- | --- | --- | --- |
| 今日新增、活跃和启动汇总 | `statistics.today` | 无 | `activityScope` |
| 今日小时趋势及昨日、七日前对比 | `statistics.period` | `metric` | `groupBy`、`groupValue`、`activityScope` |
| 昨日、周、月活跃及 DAU/MAU | `statistics.activity` | 无 | 通用维度过滤、`groupBy`、`activityScope` |
| 日期范围内的用户指标趋势 | `statistics.userTrend` | `startDate`、`endDate`、`metric` | 通用维度过滤、`groupBy`、`activityScope` |
| 日期范围内的留存 cohort | `statistics.retention` | `startDate`、`endDate`、`metric` | 通用维度过滤、`groupBy`、`activityScope` |

## 公共字段

```text
activityScope: foreground | all
groupBy:       platform | channel | version | package
channels:      string[]
appVersions:   string[]
packageNames:  string[]
platforms:     string[]
```

维度过滤值必须保留为 JSON 字符串数组。去掉首尾空白和重复项；数组元素不能为空。`groupBy` 控制响应分组，过滤字段限制查询范围，两者可以同时出现。

省略 `activityScope` 时，CLI Schema 会采用 `foreground`。除非用户明确要求包含后台活跃，否则不要传该字段。

## `statistics.today`

用于当天新增、活跃、启动汇总以及较昨日、七日前的变化。

```bash
getui-cli api call statistics.today --input '{}'
```

用户明确要求前后台全部活跃时：

```bash
getui-cli api call statistics.today --input '{"activityScope":"all"}'
```

## `statistics.period`

`metric` 必须是 `new`、`active` 或 `start`。缺少指标时先追问。`groupValue` 是单个字符串，仅用于选中 `groupBy` 下的一个值；提供 `groupValue` 时必须同时提供 `groupBy`。

```bash
getui-cli api call statistics.period --input '{"metric":"active"}'
```

```bash
getui-cli api call statistics.period --input '{"metric":"new","groupBy":"platform","groupValue":"android"}'
```

此 operation 不接受 `channels`、`appVersions`、`packageNames` 或 `platforms` 数组。

## `statistics.activity`

用于昨日活跃、周活跃、月活跃及 DAU/MAU，不需要日期参数。

```bash
getui-cli api call statistics.activity --input '{"groupBy":"platform"}'
```

```bash
getui-cli api call statistics.activity --input '{"platforms":["android","ios"]}'
```

## `statistics.userTrend`

日期格式必须是 `YYYY-MM-DD`。`metric` 允许：

```text
new | active | start | total | avgDuration | avgFrequency
```

```bash
getui-cli api call statistics.userTrend --input '{"startDate":"2026-08-05","endDate":"2026-08-11","metric":"new","platforms":["android","ios"]}'
```

## `statistics.retention`

日期格式必须是 `YYYY-MM-DD`。`metric` 允许 `new`、`active` 或 `start`。用户未说明留存类型时必须显式补充 `"metric":"new"`。

```bash
getui-cli api call statistics.retention --input '{"startDate":"2026-07-01","endDate":"2026-07-30","metric":"new"}'
```

Skill 必须在调用前拒绝 `2026-07-01` 至 `2026-07-31` 这类 31 天范围；该请求不应到达 CLI 或服务端。

## 调用规则

- 默认使用 JSON 输出，不添加 `--format`。
- 不默认使用 `--raw` 或 `--debug`。
- 正常查询前不运行 `getui-cli status`。
- 只把 JSON 对象传给 `--input`，不要同时使用文件或 stdin 输入。
- CLI 是最终 Schema 校验者。若返回字段校验错误，只请求用户修正对应字段。
