# CLI 与 Skill 环境装配

本流程负责安装、配置、验证、更新和卸载 Getui IDO CLI。主 Skill 已包含统计与用户操作能力，只需安装完整的 `ido-interface-query/` 目录，不依赖其他 Getui Skill。

## 安装前检查

检查 Git、Node.js、npm、现有 CLI、仓库和当前 Agent 客户端的 Skills 目录。Node.js 必须为 18 或更高版本。

Skills 目录优先使用用户明确指定的位置，其次使用客户端官方目录。Codex 可使用 `${CODEX_HOME:-$HOME/.codex}/skills/`；其他客户端不得照搬该路径。不支持目录式 `SKILL.md` 的客户端应使用其官方插件或导入机制。

## 首次安装

在用户指定或确认的父目录执行：

```bash
git clone https://github.com/LazySheep-dev/getui-cli.git
cd getui-cli
npm ci
npm run build
npm link
```

已有同名目录时先核对 remote 和工作树。存在未提交改动、remote 不匹配或目录不是目标仓库时停止，不得覆盖、reset 或删除。

将仓库内完整的 `skills/ido-interface-query/` 复制或导入到 `<AGENT_SKILLS_DIR>/ido-interface-query/`。必须保留 `SKILL.md`、`agents/` 和全部 `references/`。目标已存在时先比较；覆盖前备份或取得用户确认，不删除其他 Skill。

## 凭证配置

仅在用户要求时引导其在本机交互式终端执行：

```bash
getui-cli app add <alias> --app-id '<APP_ID>' --app-key '<APP_KEY>'
getui-cli app use <alias>
getui-cli app status
```

Master Secret 使用隐藏输入。不要要求用户在聊天中发送 App Key、Master Secret 或 Token，不得将凭证写入仓库、日志或 Skill 文件。CI 可使用 `GETUI_APP_ID`、`GETUI_APP_KEY`、`GETUI_MASTER_SECRET`，但不得显示其值。

## 验证

```bash
getui-cli --version
getui-cli operations list
getui-cli app status
```

同时确认目标 `ido-interface-query/SKILL.md` 和所有 references 存在且非空。没有凭证时，前两项和 Skill 文件检查通过即可判定程序安装完成，并明确业务鉴权待配置。提示用户按客户端要求重启或新建任务以重新加载 Skill。

安装验证不得自动发起真实 IDO 查询或任何远端写操作。

## 更新

工作树干净且 remote 正确时执行：

```bash
git pull --ff-only
npm ci
npm run build
npm link
```

随后备份并更新主 Skill 的完整目录，再重新验证。存在本地改动时停止，不自动丢弃。

## 卸载

解除全局 CLI：

```bash
npm unlink -g @getui/ido-cli
```

删除主 Skill、源码、profile、钥匙串凭证或缓存属于独立操作，必须准确定位并取得用户授权。不要使用宽泛目标或删除其他 Agent 配置。
