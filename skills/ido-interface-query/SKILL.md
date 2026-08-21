---
name: ido-interface-query
description: "通过现有 getui-cli 以自然语言查询个推 IDO 统计、标签、用户数据、用户群和用户向量；当用户询问这些接口、GTCID 或运营数据时使用，并将统计与用户 operation 分流处理。"
---

# IDO 接口查询

通过已安装的 `getui-cli` 将自然语言请求转换为个推 IDO 的固定 operation。统一 Skill 覆盖统计、标签、历史用户数据、用户群和用户向量；不直接访问个推 HTTP API。

## 能力分流

- **统计**：今日新增/活跃/启动、分时趋势、昨日/周/月活跃、DAU/MAU、用户趋势和留存，使用 `statistics.*`。
- **用户与标签**：标签查询/维护、历史数据导入、用户群导出和用户向量，使用 `tag.*` 或 `user.*`。
- **GTCID 咨询**：说明 SDK 获取入口，不生成 GTCID、不调用 CLI。
- **不支持**：推送、任意 URL、未知 operation、向量计算、相似度搜索和 SDK 编程请求；不构造请求。

## 按需读取 references

- 选择 operation、核对字段和生成 CLI 命令时，读取 [references/operations.md](references/operations.md)。
- 统计日期、指标、留存成熟度和默认口径时，读取 [references/statistics-semantics.md](references/statistics-semantics.md)。
- GTCID、写操作确认、用户群、向量隐私和错误处理时，读取 [references/user-safety-and-semantics.md](references/user-safety-and-semantics.md)。
- 需要自然语言示例、缺参或越界处理时，读取 [references/examples.md](references/examples.md)。

## 统一工作流

1. 识别领域并选择且仅选择一个已注册 operation；统计请求不得路由到用户 operation，用户请求也不得伪装成统计请求。
2. 收集必填参数。缺参只追问；不生成 GTCID、时间戳、事件 ID、属性、标签代码、task ID、file ID 或默认业务用户标识。
3. 在调用 CLI 前执行本地语义检查：统计日期/指标/维度、留存前天和 30 天边界、用户字段/数量上限、向量 50 条边界及写操作确认。
4. 使用默认 JSON 入口：

   ```bash
   getui-cli api call <operation> --input '<JSON>'
   ```

   用户提供文件时使用 `--input-file`；写操作只有在获得明确确认后才追加 `--yes`。不默认添加 `--raw`、`--debug` 或 `status`。
5. 只有 CLI envelope `ok: true` 时总结结果。空数组、`null` 或缺失字段表示接口未返回数据，不解释为零。
6. 失败时保留 CLI 错误码、类型、阶段、`retryable` 和脱敏后的远端信息；最终鉴权失败时才使用 `getui-cli status` 辅助诊断。

## 安全边界

- 统计和向量查询是只读，不要求确认；标签维护、用户导入和创建用户群导出任务是写操作，必须先确认。
- GTCID 只能来自 IDO SDK 或业务系统已有数据，不从 App 凭证、Token、CID 或业务 `userId` 推导。
- 留存最晚可查日期是上海时区前天；留存最多 30 个自然日；用户趋势最多 90 天。
- 向量批查最多 50 个 GTCID，不自动拆批；`vert` 原样保留，只有用户明确要求时才展开完整向量。
- 绝不输出 App ID、App Key、Master Secret、签名、Token 或不必要的完整用户数据。
