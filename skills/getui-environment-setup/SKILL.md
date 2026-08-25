---
name: getui-environment-setup
description: 安装、配置、验证、更新或卸载 Getui IDO CLI 和兼容 SKILL.md 规范的 Agent Skills；当用户要求装配个推查询环境、从 GitHub 安装 getui-cli、修复命令不可用、配置应用 profile 或检查安装状态时使用。不要用于实际业务数据查询。
---

# Getui 环境装配

帮助用户把 Getui IDO CLI 和配套 Skills 装配成可用环境，适配 Codex 及其他支持目录式 `SKILL.md` 的 Agent 客户端。主动执行能够安全自动完成的步骤，只在需要用户提供安装位置、授权或凭证时暂停。

## 路由

- 首次安装、更新、验证或卸载时，读取 [references/installation.md](references/installation.md)。
- CLI 已可用且用户开始查询统计、标签、用户群或向量时，停止本 Skill，改用统一查询 Skill 或当前客户端对应的查询入口。

## 工作原则

1. 先做只读检查：操作系统、`git`、Node.js/npm 版本、`getui-cli` 来源、目标目录、Codex Skills 目录和已有同名 Skill。
2. 默认仓库为 `https://github.com/LazySheep-dev/getui-cli.git`；已有仓库优先复用并更新，不重复克隆。
3. Node.js 必须为 18 或更高版本。缺失或版本过低时说明问题，并在用户同意后使用其现有包管理器安装或升级；不要擅自改变系统级运行时。
4. CLI 使用 `npm ci`、`npm run build`、`npm link` 安装。每一步成功后再继续，失败时保留实际错误并定位，不声称安装完成。
5. 识别当前 Agent 客户端的 Skills 目录；优先使用用户明确指定的目录，其次使用客户端环境变量或约定目录。Codex 默认是 `${CODEX_HOME:-$HOME/.codex}/skills/`，其他客户端不得套用这个路径。覆盖已有目录前先比较或备份；不得删除其他 Skills。
6. 凭证优先通过 `getui-cli app add` 的交互式隐藏输入配置。不要要求用户在聊天中发送 App Key、Master Secret 或 Token，不打印、记录或提交凭证。
7. 最终必须验证 `getui-cli --version`、`getui-cli operations list`、目标 Skill 的 `SKILL.md` 存在，以及 `getui-cli app status`。没有业务凭证时，前三项通过即可判定程序安装完成，并明确凭证仍待配置。
8. 不自动发起真实 IDO 业务查询；验证不应产生远端写操作。

## 完成反馈

简要说明 CLI 位置和版本、目标 Agent 客户端及 Skills 目录、已安装的 Skills、profile/凭证状态、验证结果，以及是否需要重启客户端或新建任务以重新加载 Skills。不要展示任何凭证值。
