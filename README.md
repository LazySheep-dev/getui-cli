# Getui IDO CLI & Skills

一个面向 Agent 的个推 IDO 命令行工具，提供统计查询、标签与用户操作、用户群导出和用户向量查询，并附带可供 Codex 使用的 Skills。

## 功能

- 统计：今日数据、周期数据、活跃统计、用户趋势、留存
- 标签：标签查询、标签树和外部标签维护
- 用户：历史用户/事件导入、用户群列表与导出
- 向量：单个或批量 GTCID 向量查询
- 凭证：本地 profile、Token 缓存、刷新、重试和脱敏错误输出

## 安装

### 环境要求

- macOS、Linux 或 Windows
- Node.js 18 或更高版本
- 一个已经开通个推 IDO 权限的应用
- 应用的 App ID、App Key，以及接口要求的 Master Secret

### 从 GitHub 安装（推荐）

```bash
git clone https://github.com/LazySheep-dev/getui-cli.git
cd getui-cli
npm ci
npm run build
npm link
```

验证安装：

```bash
getui-cli --version
getui-cli operations list
```

如果 `getui-cli` 未找到，可以不执行 `npm link`，改用：

```bash
npx . --version
```

### 配置应用凭证

使用 profile 保存 App ID 和 App Key：

```bash
getui-cli app add production \
  --app-id '<YOUR_APP_ID>' \
  --app-key '<YOUR_APP_KEY>'
```

命令会在交互式终端中询问 Master Secret。完成后选择该 profile：

```bash
getui-cli app use production
getui-cli app status
```

也可以通过环境变量提供凭证（适合 CI 或临时调用）：

```bash
export GETUI_APP_ID='<YOUR_APP_ID>'
export GETUI_APP_KEY='<YOUR_APP_KEY>'
export GETUI_MASTER_SECRET='<YOUR_MASTER_SECRET>'
```

不要把真实凭证写入 README、提交到 Git，或发送到聊天窗口。当前 profile 和 Token 状态可用下面的命令检查：

```bash
getui-cli app list
getui-cli app status
```

## 使用

### 查询支持的 operation

```bash
getui-cli operations list
getui-cli operations show statistics.today
```

### 统计查询

机器入口统一使用 `api call`，输入必须是 JSON：

```bash
getui-cli api call statistics.today --input '{"date":"2026-08-20","metric":"active"}'
getui-cli api call statistics.period --input '{"startDate":"2026-08-01","endDate":"2026-08-20","metric":"active"}'
getui-cli api call statistics.userTrend --input '{"startDate":"2026-08-01","endDate":"2026-08-20","metric":"total"}'
getui-cli api call statistics.retention --input '{"startDate":"2026-08-01","endDate":"2026-08-18","metric":"new"}'
```

统计是只读操作，不需要 `--yes`。留存最晚查询日期为上海时区前天，最多查询 30 个自然日；用户趋势最多 90 天。

### 标签与用户操作

```bash
getui-cli api call tag.user --input '{"gtcid":"<GTCID>"}'
getui-cli api call user.crowd.list --input '{}'
getui-cli user vector query --gtcid '<GTCID>'
getui-cli user vector batch --input-file vector-users.json
```

导入和创建用户群导出任务会改变远端数据，必须明确确认并添加 `--yes`：

```bash
getui-cli user import user --input-file user-import.json --yes
getui-cli user crowd export create \
  --crowd-id '<CROWD_ID>' --uid-type GTCID --yes
```

用户群导出需要手动依次执行列表、创建、状态和文件查询；CLI 不会自动轮询、下载或拆分结果。向量批量查询最多 50 个 GTCID，CLI 不会自动拆批。

### 输入文件和输出格式

```bash
getui-cli api call user.vector.batch --input-file vector-users.json
cat request.json | getui-cli api call statistics.today
getui-cli --format table api call statistics.today --input '{"date":"2026-08-20","metric":"active"}'
```

默认输出为 JSON envelope。只有明确需要原始（已脱敏）响应时才使用 `--raw`；排查问题时可将 `--debug` 输出到标准错误。

## Codex Skills

仓库包含以下 Skills：

- `skills/getui-statistics/`：自然语言统计查询
- `skills/getui-user-operations/`：标签、用户、用户群和向量操作
- `skills/ido-interface-query/`：统一的 IDO 查询入口

将对应 Skill 目录安装到 Codex 的 skills 目录后即可使用。Skill 依赖已经安装并可执行的 `getui-cli`，不会直接访问个推 HTTP API。

## 开发与测试

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

## 安全说明

- GTCID 只能来自客户端 SDK 或业务系统，不要从 Token、CID 或 App 凭证推导。
- 不要提交 `token`、`.env`、Master Secret、App Key 或其他真实凭证。
- 写操作执行前先确认目标和影响范围。
- 默认输出会对凭证、签名和敏感远端信息进行脱敏。

## 许可证

当前仓库尚未指定开源许可证。
