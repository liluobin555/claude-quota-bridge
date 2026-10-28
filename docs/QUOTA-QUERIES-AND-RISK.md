# 额度查询是否访问官方，以及频率边界

核对日期：2026-10-28。本文描述 v0.1.6 的实现边界。

## 四种操作不能混在一起计数

| 操作 | 是否新增官方请求 | 是否新增模型请求 |
|---|---|---|
| `session.usage()`读取当前CLI上下文 | 否 | 否 |
| `GET /v1/session`查询VPS桥接 | 否；只读数据库/已有缓存 | 否 |
| 消费既有Messages响应头里的5h/7d采样 | 不额外发请求 | 不额外发请求 |
| 过期后调用 `POST /v1/refresh` | 可能；有效缓存可复用，否则由槽内worker查询OAuth usage | 否，当前collector明确 `includeFable:false` |
| 原生会话压缩 | 是，正常模型请求 | 是，会产生输入/缓存/输出用量 |

主动刷新沿用vm2api的 `probeVmUsage` → slot worker usage操作。对应订阅额度路径为 `/api/oauth/usage`，worker使用自己的OAuth认证和该槽已有出口；Mac不接收OAuth Token，也不直连该官方接口。接口属于第一方服务不等于向第三方承诺长期兼容或某个安全频率。

一次刷新任务也不能永远等同于一次官方HTTP请求：worker可能先刷新过期凭据；版本差异、内部重试和其他组件的主动探测都要另算。vm2api生成的 `sk-vm-*` 是网关SK，不是Anthropic官方API Key；使用API格式访问网关不会改变底层凭据类型。

## 当前频率控制究竟是什么

1. 客户端默认每30秒读取自己的VPS桥接，不是每30秒请求官方。模型轮次、提示词和状态事件也可能触发读取VPS缓存。
2. VPS真实采样默认120秒内有效，优先读取Messages响应头与已有official缓存。
3. 仅采样陈旧、SK允许refresh、主会话空闲或暂停、且本进程距上次刷新超过60秒时，客户端才主动刷新。
4. 同一个桥接实例中，同accountRef的并发刷新共享首个结果；60秒冷却内有新鲜采样直接复用。
5. Unix socket helper还复用60秒内的成功缓存。默认模板 `allowRefresh:false`，主动刷新需要另行配置及验收。

正常活跃时响应头持续更新，可能完全不需要额外usage请求；无流量但CLI持续打开时，按现有30秒/120秒规则通常约每2～2.5分钟产生一次刷新任务。60秒是本组件常态下的最低冷却，不是官方许可的安全RPM。不能将“30秒轮询”乘会话数当成官方请求数，也不能承诺所有账号总共每分钟最多一次。

以下不在这个单实例冷却的统一管辖内：vm2api面板/内置探测器、其他额度插件、其他桥接实例、管理员直接运行collector、worker内部认证请求。内存中的并发状态会随服务重启丢失；持久缓存只保存成功样本，不能当作完整全局失败退避器。多实例/多账号推广前需要把同一账号的provider、缓存、锁和计数集中管理。

## 限流与封号

本次未找到为订阅 `/api/oauth/usage` 公开承诺安全RPM或不封号的官方资料。公开[API限流文档](https://platform.claude.com/docs/en/api/rate-limits)解释了Messages API的RPM/ITPM/OTPM及429、Retry-After；不能直接套用到订阅usage接口。一次429不等于账号停用，但也不能据此保证第三方使用没有账号风险。

官方[鉴权说明](https://code.claude.com/docs/en/legal-and-compliance)限制第三方代持、收集或转发订阅OAuth凭据，以及替用户中转订阅使用。降低刷新频率不能消除这项风险。用户自有原版CLI登录与对外提供订阅账号池须分别判断；对外产品应按官方说明使用API Key或受支持云平台及相应授权。

当前封装还有明确不足：worker官方usage的429/401/403等失败，经collector/socket后可能只显示 `quota_refresh_failed`；桥接没有完整持久化官方Retry-After。现有60秒冷却和单次查询合并，不等于已实现官方限流退避。不要把服务返回的本地 `refresh_throttled` 或 `rate_limited` 当作官方429，也不要把502/503直接当作封号证据。

公开推广前建议补齐：按账号记录真实usage调用与状态；遇官方429遵守其Retry-After并持久化熔断；401/403区分凭据失效、scope不足和其他权限错误，停止无效轮询；与vm2api自身探测器共享预算；保留仅使用被动采样、关闭主动刷新选项。这些是后续增强项，本次没有宣称已经部署。

## 怎样核对实际请求数

网关Messages日志里的“请求数/费用”不包含全部usage GET；模型请求数量不能用来证明官方usage查询总量。当前也没有统一、持久的全账号官方usage请求计数面板。

诊断应分别统计：桥接缓存读取次数、刷新任务次数、合并/缓存命中次数、worker实际usage GET次数、OAuth刷新次数、官方响应状态与Retry-After。记录accountRef、时间、原因和状态即可，不记录Token、Cookie或完整对话。不要为了测限流主动向官方压测，不使用换IP/换号等方式绕过限流。

如果希望完全不由本组件新增官方查询，使用 `allowRefresh:false`、不配置usage socket，仅消费已有采样；采样过期时自动动作会保守停下，不能同时承诺永久新鲜额度。这个开关不会自动停止vm2api面板或其他工具自己的查询。

第三方部署和真正合入vm2api的差别见 [VM2API-ADOPTION.md](VM2API-ADOPTION.md)。
