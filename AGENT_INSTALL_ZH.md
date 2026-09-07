# Getui CLI 与 Agent Skills 自动安装提示词

将下面整段内容直接交给支持执行本地命令的 Agent 客户端。客户端必须严格按顺序执行，任一步失败立即停止并报告实际错误，不得假装完成。

```text
请自动安装 Getui IDO CLI 和全部 Agent Skills。

仓库： https://github.com/LazySheep-dev/getui-cli.git
Skills：getui-environment-setup、ido-interface-query、getui-statistics、getui-user-operations

1. 查找 Skills 目录（先去重）：
[ -d "$HOME/.agents/skills" ] && echo "USER: $HOME/.agents/skills"
[ -d "$PWD/.agents/skills" ] && echo "PROJECT: $PWD/.agents/skills"
for d in "$HOME"/.*/skills; do [ -d "$d" ] && echo "USER: $d"; done
for d in "$PWD"/.*/skills; do [ -d "$d" ] && echo "PROJECT: $d"; done

只有 USER 时使用该目录；只有 PROJECT 时使用该目录；两者都有时必须询问用户选择“全局安装”或“项目安装”；都没有时创建 "$HOME/.agents/skills"。将所选目录记为 SKILLS_DIR。

2. 准备仓库：若当前目录不是该仓库，则在用户指定的父目录执行：
git clone https://github.com/LazySheep-dev/getui-cli.git

已有同名目录时先检查 remote 和工作树；有未提交改动、remote 不匹配或目录不是该仓库时立即停止，不得覆盖、reset 或删除。

3. 检查 node --version，必须为 18 或更高版本。进入仓库后严格依次执行：
npm ci
npm run build
npm link

每步成功后才能继续。用 getui-cli --version 和 getui-cli operations list 验证；npm link 失败时必须报告 CLI 未全局注册。

4. 安装以下完整 Skill 目录到 "$SKILLS_DIR"：
skills/getui-environment-setup/
skills/ido-interface-query/
skills/getui-statistics/
skills/getui-user-operations/

每个目标已有 SKILL.md 时先询问是否覆盖；拒绝则停止。覆盖前先备份原目录。复制时必须保留 SKILL.md、agents/ 和 references/。客户端不支持目录式 SKILL.md 时，改用其官方导入/插件机制并报告结果。

5. 验证：确认 getui-cli --version、getui-cli operations list 成功，且四个目标 Skill 的 SKILL.md 存在且非空。报告 CLI 路径和版本、仓库路径、SKILLS_DIR、每个 Skill 状态，并提示重启或新建 Agent 任务刷新 Skill 列表。

没有凭证时不要执行真实 IDO 查询；标记为“CLI 和 Skills 已安装，业务凭证待配置”。不要要求用户在聊天中发送 App Key、Master Secret 或 Token。只有用户明确要求配置凭证时，才让用户在本机终端执行：
getui-cli app add <alias> --app-id '<APP_ID>' --app-key '<APP_KEY>'
getui-cli app use <alias>
getui-cli app status

安装验证不得导入用户、维护标签或创建导出任务。最终用中文报告实际结果；失败时只报告失败步骤、错误信息和已完成步骤。
```
