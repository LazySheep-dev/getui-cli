# 个推 IDO Skill 使用指南

## 一、什么是个推 IDO Skill

个推 IDO Skill 是为智能体提供的个推数据专项指令集，帮助 Agent 理解个推 IDO 的统计、标签、用户数据、用户群和用户向量能力。

安装后，你可以直接用自然语言完成以下操作：

- 查询新增用户、活跃用户、启动次数和 DAU/MAU
- 查询用户趋势、分时数据和留存
- 查询或维护用户标签
- 导入历史用户或事件数据
- 查询用户群并创建导出任务
- 查询单个或批量用户向量

Skill 负责理解自然语言、选择正确的 operation 和检查参数；真正的请求由 `getui-cli` 执行，不需要 Agent 直接拼接个推 API 请求。

## 二、哪些工具可以调用 Skill？

Skill 是标准化的能力模块，不绑定某一个特定软件。支持目录式 `SKILL.md` 或官方 Skill/插件导入机制的 Agent 客户端，都可以使用本项目的 Skill，例如：

| 工具 | 类型 | 使用方式 |
| --- | --- | --- |
| Codex | 桌面 AI 助手 | 放入客户端 Skills 目录 |
| QoderWork | 桌面 AI 助手 | 在对话中导入 Skill 文件或目录 |
| OpenClaw | 桌面 AI 工具 | 使用其 Skill 安装入口 |
| Hermes Agent | AI Agent 平台 | 使用其 Skill/插件导入机制 |
| 其他 Agent 客户端 | Agent 工具 | 按客户端官方方式导入 `SKILL.md` 目录 |

不同客户端的目录位置和导入方式可能不同。不要把某个客户端的目录路径当作通用路径；如果客户端不支持 `SKILL.md` 目录格式，应使用其官方转换或插件机制。

## 三、本项目包含哪些 Skill？

| Skill | 能力 |
| --- | --- |
| `getui-environment-setup` | 自动检查、安装、构建和验证 CLI 与全部 Skill |
| `ido-interface-query` | 统一路由环境装配和 IDO 查询 |
| `getui-statistics` | 查询并解释统计、趋势和留存 |
| `getui-user-operations` | 查询和管理标签、用户、用户群和用户向量 |

## 四、如何安装与使用个推 IDO Skill

### 方式 A：让 Agent 自动完成安装（推荐）

#### 第一步：准备安装提示词

打开文件 [`AGENT_INSTALL_ZH.md`](AGENT_INSTALL_ZH.md)，复制其中的完整中文提示词。

#### 第二步：发送给 Agent

把提示词发送给支持本地命令执行和 Skill 导入的 Agent 客户端，并发送：

```text
请严格按照这份提示词，自动安装 Getui CLI 和全部 Agent Skills。
```

Agent 会依次完成：

1. 查找当前客户端的 Skill 目录
2. 克隆 GitHub 仓库
3. 安装依赖并构建 CLI
4. 注册 `getui-cli` 命令
5. 安装四个 Getui Skill
6. 验证 CLI 和 Skill 是否可用

如果中途失败，Agent 必须停止并报告错误，不会继续覆盖文件。

#### 第三步：确认安装成功

可以发送：

```text
请检查 Getui CLI 和所有 Getui Skill 是否安装成功，并告诉我安装路径和版本。
```

正常情况下，Agent 应能确认：

- `getui-cli --version` 可以执行
- `getui-cli operations list` 可以执行
- 四个 Skill 目录中都存在非空的 `SKILL.md`
- Agent 客户端已加载或提示需要重启/新建任务

### 方式 B：手动安装后导入 Skill

如果 Agent 客户端不支持自动执行安装，可以手动执行：

```bash
git clone https://github.com/LazySheep-dev/getui-cli.git
cd getui-cli
npm ci
npm run build
npm link
```

然后按照客户端官方方式导入以下四个目录：

```text
skills/getui-environment-setup/
skills/ido-interface-query/
skills/getui-statistics/
skills/getui-user-operations/
```

必须导入完整目录，不能只复制 `SKILL.md`；`agents/` 和 `references/` 中的文件也需要保留。

## 五、如何配置个推凭证

安装 CLI 和 Skill 不等于已经配置业务凭证。需要查询真实数据时，在本机终端执行：

```bash
getui-cli app add production \
  --app-id '<YOUR_APP_ID>' \
  --app-key '<YOUR_APP_KEY>'

getui-cli app use production
getui-cli app status
```

Master Secret 应在终端的隐藏输入中填写，不要发送到聊天窗口，也不要提交到 GitHub。

没有配置凭证时，可以完成安装验证，但不能查询真实 IDO 数据。

## 六、如何使用

安装并配置完成后，可以直接用自然语言提问。

### 统计查询

```text
查询昨天的活跃用户数
查询最近 7 天的新增用户趋势
查询前天之前最近 30 天的新用户留存
按平台对比本月活跃用户
```

### 用户和标签

```text
查询这个 GTCID 的标签
导入这份历史用户数据
查询当前可导出的用户群
查询这个 GTCID 的用户向量
```

涉及标签维护、用户导入或创建用户群导出任务时，Agent 应先说明影响并要求明确确认。

## 七、安全注意事项

- 不要把 App ID、App Key、Master Secret、Token 发到聊天窗口。
- GTCID 必须来自客户端 SDK 或业务系统，不能由 Agent 推导或猜测。
- 安装验证不会自动执行真实业务查询或写操作。
- 标签维护、用户导入和创建用户群导出任务需要明确确认。
- Agent 默认不会输出完整凭证、签名或不必要的用户数据。
