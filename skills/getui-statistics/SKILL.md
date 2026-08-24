---
name: getui-statistics
description: 通过现有 getui-cli 查询并解释个推用户运营统计数据，覆盖今日新增/活跃/启动、分时趋势、日周月活跃与 DAU/MAU、用户趋势和留存。当用户用自然语言询问个推统计指标、日期趋势、平台/渠道/版本/包名维度对比或留存表现时使用。
---

# Getui Statistics

将用户的自然语言统计请求转换为现有 Getui CLI 的固定 operation 调用，并返回简短客观摘要和完整结构化结果。

## 能力边界

只支持以下五个只读 operation：

- `statistics.today`
- `statistics.period`
- `statistics.activity`
- `statistics.userTrend`
- `statistics.retention`

超出范围时明确说明首版不支持，不构造其他 operation、URL 或 HTTP 请求。不要在本 Skill 中实现鉴权、Token、HTTP、重试或响应标准化。

## 按需读取参考资料

- 选择 operation、构造输入或核对枚举时，读取 [references/operations.md](references/operations.md)。
- 转换日期、选择指标、应用默认口径或解释留存时，读取 [references/metric-semantics.md](references/metric-semantics.md)。
- 遇到缺参、鉴权、权限、空数据、响应异常或其他易混淆场景时，读取 [references/examples.md](references/examples.md)。

## 工作流

1. 识别用户意图并选择且仅选择一个受支持的 operation。
2. 收集必填参数。参数完整则直接查询；缺少必填项时只追问缺失项；存在关键歧义时只确认相关口径。
3. 按 `Asia/Shanghai` 将自然语言日期转换为 `YYYY-MM-DD`，并按 operation 处理相对日期。留存的最晚成熟日期是当前自然日减 2 天，即前天；“最近 N 天留存”以前天为 `endDate`，再向前取包含首尾共 N 天。用户趋势的“最近 N 天”仍截止昨天。
4. 对 `statistics.retention` 先校验 `endDate` 不晚于前天，再校验包含首尾最多 30 个自然日。明确日期晚于前天时不要自动改写，停止且不生成或执行 CLI；说明实际结束日期、当前最晚日期，以及昨天的次日留存需今天结束后才完整形成。该规则适用于 `new`、`active`、`start`。
5. `statistics.userTrend` 继续使用最多 90 天规则。包含首尾的天数为结束日期与开始日期的自然日差加 1。
6. 留存未指定类型时补充 `metric: "new"`。活跃范围未指定时不要传 `activityScope`。
7. 将输入构造成 JSON 对象，通过固定入口执行：

   ```bash
   getui-cli api call <operation> --input '<JSON>'
   ```

8. 解析 CLI 的 JSON envelope。只有 `ok: true` 时才生成数据摘要。
9. 返回简短客观摘要，只有在用户显示指定时才输出原样保留完整结构化 JSON，否则默认不显示。摘要说明日期、指标、过滤条件以及实际采用的默认口径。

五个 operation 均为只读查询，执行前无需二次确认。正常查询前不要额外运行 `getui-cli status`，也不要默认添加 `--debug` 或 `--raw`。

## 结果规则

- 只陈述数值、变化和查询口径，不自动推断原因。
- 空数组、`null` 或缺失字段表示接口未返回数据，不等于零。
- 比例与单位按 CLI 输出解释，不自行换算或猜测。
- CLI 返回错误时保留错误码和具体无效字段，不根据残缺结果生成摘要。

## 鉴权与错误

- Token 缓存、刷新和请求重放由 CLI 负责。
- 最终出现 `GETUI_CLI_TOKEN_REJECTED` 或 `GETUI_CLI_HTTP_UNAUTHORIZED` 时，运行 `getui-cli status`，仅用凭证来源和 Token 状态辅助诊断。
- 凭证缺失时引导用户在 CLI 环境配置凭证，不要求其在对话中发送密钥。
- 权限、IP 白名单、网络、远端服务和响应不兼容错误均保留 CLI 错误码，并给出对应的下一步检查项。

绝不输出 App ID、App Key、Master Secret、签名或 Token。提醒用户环境变量可能覆盖默认 profile，但不要展示环境变量值。
