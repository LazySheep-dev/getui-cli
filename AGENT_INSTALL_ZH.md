# Getui CLI 与 Agent Skills 自动安装提示词

将下面整段内容直接交给支持执行本地命令的 Agent 客户端。客户端必须严格按顺序执行，任一步失败立即停止并报告实际错误，不得假装完成。

```text
请自动安装 Getui IDO CLI 和唯一的主 Agent Skill。

仓库： https://github.com/LazySheep-dev/getui-cli.git
Skill：ido-interface-query（已内置环境装配、统计和用户操作能力）

1. 查找 Skills 目录（先去重）：
[ -d "$HOME/.agents/skills" ] && echo "USER: $HOME/.agents/skills"
[ -d "$PWD/.agents/skills" ] && echo "PROJECT: $PWD/.agents/skills"
for d in "$HOME"/.*/skills; do [ -d "$d" ] && echo "USER: $d"; done
for d in "$PWD"/.*/skills; do [ -d "$d" ] && echo "PROJECT: $d"; done

只有 USER 时使用该目录；只有 PROJECT 时使用该目录；两者都有时必须询问用户选择“全局安装”或“项目安装”；都没有时创建 "$HOME/.agents/skills"。将所选目录记为 SKILLS_DIR。

2. 准备仓库：若当前目录不是该仓库，则在用户指定的父目录执行：
git clone https://github.com/LazySheep-dev/getui-cli.git

已有同名目录时先检查 remote 和工作树；有未提交改动、remote 不匹配或目录不是该仓库时立即停止，不得覆盖、reset 或删除。

3. 检查并验证 Node.js 环境。项目要求 Node.js 18 或更高版本；只检查，不要自行安装、升级、切换或覆盖 Node.js：
command -v node || true
command -v npm || true
node --version 2>/dev/null || true

如果 node 或 npm 不存在，或者 `node --version` 的主版本低于 18，立即停止并提示用户自行安装或升级 Node.js 18+；不得继续构建，也不得使用 nvm、安装脚本或 sudo 修改用户环境。

验证当前环境：
command -v node
command -v npm
node --version
npm --version
npm prefix -g
NPM_GLOBAL_PREFIX="$(npm prefix -g)"
[ -d "$NPM_GLOBAL_PREFIX" ] && [ -w "$NPM_GLOBAL_PREFIX" ]

确认 `node --version` 的主版本至少为 18，且 node、npm 和 npm 全局前缀属于当前用户可用的 Node.js 环境。若 npm 全局前缀指向当前用户不可写的系统目录（例如 `/usr/local`），立即停止并报告实际路径和权限问题，不得使用 sudo 绕过。

环境验证通过后，进入仓库并严格依次执行：
npm ci
npm run build
npm link

每步成功后才能继续。用 getui-cli --version 和 getui-cli operations list 验证；npm link 失败时必须报告 CLI 未全局注册。

4. 只安装以下一个完整 Skill 目录到 "$SKILLS_DIR"：
skills/ido-interface-query/

目标已有 SKILL.md 时先询问是否覆盖；拒绝则停止。覆盖前先备份原目录。复制时必须保留 SKILL.md、agents/ 和全部 references/。主 Skill 已内置另外三个子 Skill 的能力，不要再下载或安装它们。客户端不支持目录式 SKILL.md 时，改用其官方导入/插件机制并报告结果。

5. 验证：确认 getui-cli --version、getui-cli operations list 成功，且 "$SKILLS_DIR/ido-interface-query/SKILL.md" 存在且非空。报告 Node.js 实际路径和完整版本、npm 实际路径和全局前缀、CLI 路径和版本、仓库路径、SKILLS_DIR、主 Skill 状态，并提示重启或新建 Agent 任务刷新 Skill 列表。

没有凭证时不要执行真实 IDO 查询；标记为“CLI 和 Skills 已安装，业务凭证待配置”。不要要求用户在聊天中发送 App Key、Master Secret 或 Token。只有用户明确要求配置凭证时，才让用户在本机终端执行：
getui-cli app add <alias> --app-id '<APP_ID>' --app-key '<APP_KEY>'
getui-cli app use <alias>
getui-cli app status

安装验证不得导入用户、维护标签或创建导出任务。最终用中文报告实际结果；失败时只报告失败步骤、错误信息和已完成步骤。
```
