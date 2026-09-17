# agent18 0.8：已有业务接口与语义上下文接入

0.8 在 [0.7 支持与运行排查](agent18-0.7-operations.md)基础上，完成一组真实 SaaS 接入改进：审核过的只读 POST 查询、宿主业务事件、基于失败操作的对话引导、可确认的上报快照，以及工程排查中的事件关联。

## 本轮实现

| 接入者的需求 | 现在的行为 | 实现位置 |
| --- | --- | --- |
| 现有查询是 POST /search | 部署者单独审核并登记只读操作；固定请求方法、路径与平铺 JSON body，继续检查角色、参数、Policy、字段与 SaaS 对象权限 | [QueryService](../../packages/actions/src/queries.ts)、[工作台登记组件](../../apps/console/src/query-registration.tsx) |
| 助手不知道刚才哪里失败 | setContext 描述页面/实体；emit 报告操作、错误码与关联 ID | [SDK](../../packages/web-sdk/src/index.ts)、[事件合同](../../packages/contracts/src/context.ts) |
| 客户只问“为什么不行” | 有近期、当前对象、未恢复的失败时进入支持预览，不执行业务接口 | [对话路由](../../packages/actions/src/conversation.ts) |
| 页面切换后上报内容变了 | 预览冻结上下文与采集；取消附带时 context/capture 一起省略 | [对话组件](../../packages/web-sdk/src/widget.ts) |
| 工程师看不见业务失败线索 | 工单持久化事件，Owner 查看；排查读取失败事件 traceId，按可信 scope 查询 Loki | [观测任务](../../packages/application/src/observations.ts)、[工程视图](../../apps/console/src/observations.tsx) |

## 一次调用的完整路径

业务查询：客户输入需求 → Core 按当前身份给出已登记查询 → 对话补齐参数 → Core 校验参数、角色与 Policy 并写审计 → 固定 GET 或已审核 POST → SaaS 验证用户和对象归属 → Core 字段投影 → 返回结果和查询时间。

问题上报：宿主业务失败 → SDK 内存事件 → 客户询问失败原因 → 支持预览 → 客户核对或省略上下文 → Case/outbox/排查任务持久化 → Worker 获取租约 → 按可信 scope 查询 HTTP/Loki/Prometheus → Owner 查看证据并回复 → 客户确认解决，处理经验生成内部草稿。

POST 查询与写操作的执行器仍分开。`readOnly: true` 是部署者确认，不会把有副作用的接口变成只读；上游实际语义和授权必须检查。所有业务写入继续走 prepare → 明确确认 → execute → receipt/reconcile。没有自由 URL、自由 GraphQL、任意请求体或后台自动重发写入。

## 升级与验收

先备份，更新源码并执行 `pnpm install --frozen-lockfile`、`pnpm deploy:start`，重启本地工作台。本轮没有新增数据库迁移，已有 GET 配置默认保持 GET；新 POST 必须带明确只读审核。迁移文件仍到 009，历史工单 context 无事件字段也能读取。

本地合成演示可用 `pnpm demo:actions` 更新 invoice-demo 的业务目录，再 `pnpm demo:start` 应用；此命令会替换演示项目的业务配置，只用于合成演示，不用于正式项目。真实项目从工作台单独登记查询。

至少验证：查询返回正确对象、跨租户拒绝、撤权、额外参数拒绝、响应投影、失败不重试；业务事件不立即联网、过期/恢复/路由切换清理、伪造 scope 被拒、报告预览和持久内容一致、取消附带、Worker 读取真实日志与客户输出隔离。详见[业务查询](../guides/business-queries.md)、[语义上下文](../guides/semantic-context.md)和[本轮验证记录](../development/round8-integration.md)。

## 仍需继续开发

普通 Conversation 的跨刷新持久化、远程 Operator SSO/RBAC、可靠 Webhook、官方镜像/npm 分发、分布式配额与自身遥测，仍是下一阶段的重要工作。完整 Trace、知识质量评测、数据保留删除与自动代码修复也未由本轮交付。优先级和验收条件见[公开路线图](../planning/mvp-roadmap.md)。
