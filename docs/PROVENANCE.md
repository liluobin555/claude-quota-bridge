# 来源与许可证

`src/vendor/quota-guard-core.ts` 来自 [catsmonster/claude-quota-guard](https://github.com/catsmonster/claude-quota-guard)，提交 `8a28fea50a2848f407ae08bad4589c255ea78d91`，文件 `hooks/core.ts`，插件版本 0.3.6，MIT License。完整上游许可证保存在 `src/vendor/QUOTA-GUARD-LICENSE`。

同目录 `.mjs` 使用 Node 的 `stripTypeScriptTypes(...,{mode:'strip'})` 去除类型并清理行尾空格生成，未修改上游行为；本项目的身份保护、失败恢复和读写边界位于外围控制器。不能直接把未加保护的上游 core 作为网关恢复逻辑使用：上游有盲探恢复行为。

其余本项目新增代码采用根目录 MIT License。

实现依据：

- [Claude Code Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)
- [Claude Code session management](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code subagent compaction](https://code.claude.com/docs/en/sub-agents#auto-compaction)
- [vm2api v1.3.219 identity-rewrite](https://github.com/dofastted/vm2api/blob/v1.3.219/src/lib/identity/identity-rewrite.mjs)
- [vm2api v1.3.219 key scope](https://github.com/dofastted/vm2api/blob/v1.3.219/src/lib/admin/key-scope.mjs)

官方 Mods 类型处于早期变化阶段，应以目标 Claude Code 的 `claude plugin validate` 及原生运行测试为准。运行时生成的类型缓存不包含在公开源码中。
