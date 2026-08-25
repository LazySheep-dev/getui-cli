# 安装、更新与卸载流程

## 安装前检查

```bash
git --version
node --version
npm --version
command -v getui-cli
```

Node.js 必须为 18 或更高版本。先询问或识别目标 Agent 客户端的 Skills 目录；不要假定所有客户端都使用同一目录。Codex 使用 `CODEX_HOME/skills`（未设置时 `$HOME/.codex/skills`），其他客户端使用其官方配置目录或用户指定目录。不要重定义 `HOME` 或 `CODEX_HOME`。

## 首次安装

在用户确认或现有工作区明确指定的父目录中执行：

```bash
git clone https://github.com/LazySheep-dev/getui-cli.git
cd getui-cli
npm ci
npm run build
npm link
```

不要克隆到已有的非空同名目录。存在仓库时检查 remote 和工作树；有用户改动时不要覆盖，停止并说明。

## 安装 Agent Skills

安装以下完整目录：

```text
skills/getui-environment-setup/
skills/ido-interface-query/
skills/getui-statistics/
skills/getui-user-operations/
```

目标是 `<AGENT_SKILLS_DIR>/<skill-name>/`。同名目录不存在时复制；存在时先比较。来源较新且用户同意更新时，将旧目录移动为带时间戳的备份，再复制完整目录。必须保留 `SKILL.md`、`agents/` 和 `references/`。如果客户端不支持目录式 `SKILL.md`，不要伪造安装成功；说明需要使用该客户端的导入/插件机制，或由用户指定转换方式。

安装后提示用户重启目标 Agent 客户端或新建任务，让 Skill 列表重新加载。若客户端要求显式启用 Skill，提醒用户在其设置中启用对应目录。

## 配置凭证

交互式终端中运行：

```bash
getui-cli app add <alias> --app-id '<APP_ID>' --app-key '<APP_KEY>'
getui-cli app use <alias>
getui-cli app status
```

让用户在终端自行输入参数和隐藏的 Master Secret；聊天中不收集真实值。如果环境无法安全隐藏输入，只提供命令模板，让用户本地执行。

CI 可使用 `GETUI_APP_ID`、`GETUI_APP_KEY`、`GETUI_MASTER_SECRET`，但不得把值写入仓库、日志或 Skill 文件。

## 验证

```bash
getui-cli --version
getui-cli operations list
getui-cli app status
```

同时确认四个 Skill 目录下均存在 `SKILL.md`。`app status` 因未配置凭证而失败不代表 CLI 安装失败，应区分“程序已安装”和“业务凭证未配置”。

## 更新

先检查工作树。工作树干净时：

```bash
git pull --ff-only
npm ci
npm run build
npm link
```

然后更新 Skill 副本并重新验证。工作树有本地改动或远程地址不匹配时停止，不自动丢弃或覆盖。

## 卸载

```bash
npm unlink -g @getui/ido-cli
```

删除源码、profile、凭证或已安装 Skills 属于独立操作，必须逐项获得用户明确授权并准确确认目标。优先保留或备份配置；不得使用宽泛递归删除。
