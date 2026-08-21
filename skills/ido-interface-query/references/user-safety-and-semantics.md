# 安全与语义

## GTCID 来源

GTCID 是个推 IDO 客户端 SDK 生成的用户标识。它不是 App ID、App Key、Master Secret、Token、CID，也不是业务 `userId`。Skill 只接受 SDK 或业务系统已经提供的 GTCID，不生成、哈希、转换或猜测它。

先满足应用自己的隐私授权要求，再初始化 SDK 并读取标识。需要向用户说明获取入口时，可引用个推官方文档：

- [Android 初始化与回调](https://docs.getui.com/ido/mobile/android/init/)
- [Android API](https://docs.getui.com/ido/mobile/android/api/)
- [iOS API](https://docs.getui.com/ido/mobile/ios/api/)
- [H5/小程序 API](https://docs.getui.com/ido/mobile/miniProgram/api/)
- [鸿蒙初始化](https://docs.getui.com/ido/mobile/harmonyos/init/)

核心入口：

```text
Android: GsManager.setGtcIdCallback(...).onGetGtcId(...)；初始化后可用 getGtcid(context)
iOS:    GTCountSDKDidReceiveGtcid(...) 回调或 GTCountSDK.gtcid
H5/MP:  SDK 启动后调用 GsIdo.gtcid()
鸿蒙:   Ido.init(context) 返回 Promise<string> 的 gtcId
```

`setUserId` 只设置业务用户 ID，不会替代 GTCID。CLI 的 `tag.user`、导入和用户群接口也不会从凭证反查任意用户 GTCID。

## 写操作确认

以下 operation 有远端副作用：

```text
tag.external.create
tag.external.edit
tag.external.import
tag.external.trigger
user.import.event
user.import.user
user.crowd.export.create
```

`user.vector.query` 和 `user.vector.batch` 是只读查询，不要求确认。

执行前展示：

- operation 和动作类型；
- 标签代码、用户群 ID 或导入目标；
- 记录数或 ID 数量；
- 可能产生的远端变化。

只有用户明确回复“确认”“执行”“是”等，才能执行带 `--yes` 的 CLI 命令。模糊的“帮我处理”不算确认。未确认时不要读取 profile、获取 Token 或触发任何网络调用。

确认只覆盖当前一步。不要把一个自然语言请求扩展成未明确要求的其他写操作。

## 导入边界

- 事件和用户导入各自最多 200 条；超过上限直接拒绝，不自动拆批。
- `datetime` 必须是 13 位毫秒时间戳字符串；不要把秒转换成毫秒。
- `properties.$app_type` 只能是 `app`、`mp` 或 `h5`；`properties.$os` 必须是非空字符串。
- `properties` 中的业务自定义字段可以透传，但不能由 Skill 猜测缺失值。
- 不把自然语言、CSV、Excel 或截图自动转换为官方 JSON；先请求 JSON 或文件路径。
- 成功导入摘要只展示服务端 `code`/`msg`、导入类型和记录数，不回显完整 GTCID、属性或 dataList。

## 用户群导出语义

用户群导出是四步人工流程：

1. `user.crowd.list` 获取可导出用户群。
2. 用户明确选择 `crowdId` 和 `uidType`；创建任务前再次确认。
3. 用户提供 task ID 后执行 `user.crowd.export.status`。
4. 用户提供 file ID 后执行 `user.crowd.export.file`。

不要自动轮询状态、自动遍历全部文件、自动下载、拆批或合并。用户群导出可能需要 VIP 权限；远端权限错误必须原样保留并提示检查权益。

## 结果解释

- 只在 CLI envelope `ok: true` 时总结成功数据。
- `null`、缺失字段和空数组表示接口没有返回可用数据，不等于数值零。
- 读操作摘要对象数量、标签状态、任务状态或文件数量，并保留结构化结果。
- 文件接口默认不在正文展开大 ID 列表；用户明确要求完整列表时才展示 JSON 数据。
- 不根据标签、用户数量或任务状态推断业务原因。
- 向量查询成功时默认摘要查询总数、有效/无效数量和 `vert` 是否存在；完整向量仅在用户明确要求时展示。`vert` 原样保留，不解析、四舍五入或转换。
- 向量查询返回 VIP、权限或 IP 白名单错误时，保留 CLI 的错误码、远端 `code`/`msg` 和 `retryable`，提示检查个推权益与白名单。

## 鉴权与错误

Token 缓存、刷新、401/业务失效重放和 HTTP 错误由 CLI 负责。正常查询前不要额外运行 `getui-cli status`。

当 CLI 最终返回鉴权错误时才运行：

```bash
getui-cli status
```

只说明 `credentialSource`、`secretStored`、`tokenStatus` 等状态；不展示 App ID、密钥、签名或 Token。环境变量可能覆盖 profile，提醒用户检查来源即可。

对权限/VIP、IP 白名单、网络、业务错误和响应结构不兼容：

- 保留 CLI 错误码、错误类型、阶段和 `retryable`；
- 保留经过 CLI 脱敏和限长处理的远端响应；
- 指出下一步检查项，不根据错误响应编造成功数据。

## 标识与日志最小化

GTCID、CID、业务 userId、tagCode、crowdId 和 fileId 都可能关联用户或业务数据。确认和诊断中优先显示数量、类型和掩码值；不要把这些值写入 profile、Skill 文件或额外日志。绝不输出凭证、Token、签名或 Authorization 值。
