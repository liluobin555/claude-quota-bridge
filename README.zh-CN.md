# Claude Quota Bridge

面向 Claude Code 的额度感知压缩插件与 vm2api 只读桥接服务。覆盖交互式 CLI 和受管理的 `claude -p`，不修改 vm2api 核心代码。

默认在账号 **5h 使用率 ≥85% 或 7d 使用率 ≥90%**，且当前会话上下文达到运行时模型窗口的 **50%** 时，等待主轮次和已跟踪子 Agent 结束后压缩。同一会话、账号和额度窗口只尝试一次；成功后允许用户和 Agent 正常继续。自动恢复默认关闭，不自动换号。

上下文上限来自当前 CLI 的 `session.usage().context`，随运行时模型变化；缺失的计数不会被伪造为零。远端额度来自已有响应头或可选的 usage 查询，不用额外模型请求探活。压缩本身仍会消耗模型额度。

通过专用启动器按进程启用，并检查 API 网关地址。普通订阅会话、桌面应用和其他 API 进程不会因为安装仓库而自动启用。桥接不可用或身份校验失败时，受管理会话可能暂停；它不是普通 Claude 的透明替代品。

- [英文首页与启动示例](README.md)
- [客户端接入、故障行为与退出码](docs/CLIENT-SETUP.md)
- [VPS 部署与 HTTPS](docs/SERVER-SETUP.md)
- [第三方接入、升级 vm2api 与上游集成](docs/VM2API-ADOPTION.md)
- [额度查询频率与风险](docs/QUOTA-QUERIES-AND-RISK.md)
- [测试方式](docs/TESTING.md)
- [隐私和安全边界](SECURITY.md)

已验证组合为 vm2api v1.3.219、macOS Claude Code 2.1.303。Windows 原生运行尚未完整验收；其他 vm2api 版本须先核对数据库结构、身份绑定与 worker 接口。项目处于实验阶段，不承诺账号安全，也不提供规避服务限制的能力。

公开包使用全新历史，仅包含通用源码、示例和测试夹具；没有真实服务地址、账号、SK 或原部署报告。MIT 许可证和上游公开署名保留。
