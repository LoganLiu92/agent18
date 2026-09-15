# 开源评审核验与研发优先级

核验日期：2026-09-15。代码基线：`45a294b46fbc80f7a249e512be7dfb6762872187`（0.7.0）。本页区分评审中的事实、建议和本轮改动。后续版本以[当前路线图](mvp-roadmap.md)与实际代码为准。

## 产品定位与可直接使用的文案

Agent18 面向已经有登录、业务 API、文档与监控的 SaaS 团队，提供可自托管、可嵌入的支持助手。客户在同一个对话里找答案、查业务、确认办理和报告问题；支持人员结合运行证据继续处理，并把经验沉淀为审核过的知识。

| 使用位置 | 建议文案 |
| --- | --- |
| 中文一句话 | 让 SaaS 助手回答问题、办理业务、排查故障。 |
| GitHub Description | Open-source support agent for SaaS: answer, act, and investigate safely. |
| 英文首页 | AI support that can answer, act, and investigate. |
| 英文说明 | Agent18 connects product knowledge, user-scoped APIs and runtime evidence in an embedded support conversation. |
| 安全理念 | AI reasons. Your system remains in control. |
| 业务能力 | 先看具体变更，确认后办理，结果有据可查。 |
| 问题排查 | 带上页面线索，连接运行证据，持续跟进处理。 |
| 知识更新 | 从已有资料构建知识，从解决经验生成待审核草稿。 |

当前产品说明使用“支持助手”便于首次理解；设计讨论可以使用 Support Runtime 表达身份、执行和证据管理职责。避免“回答所有问题”“给仓库和 Key 即可自动适配所有接口”“已证明根因”“自动修好线上故障”等超出验收范围的承诺。英文 README 明确当前详细指南和内置 UI 主要为中文。

## 第一份工程评审的核实结果

| 评审意见 | 核实结果与证据 | 处理 |
| --- | --- | --- |
| 文档版本漂移 | 部分属实：CONTRIBUTING 指向 0.5；CHANGELOG 缺 0.7；原路线图将运行调查整体列为待实现 | 本轮修正，新增能力清单与文档检查 |
| INTEGRATE 仍是 0.6 且没有真实日志 | 与基线不符：[INTEGRATE](../../INTEGRATE.md) 已描述 0.7、页面报告和 HTTP/Loki/Prometheus | 保留已实现范围；增加受控版本区块 |
| 官方分发未交付 | 属实：[Compose Dockerfile](../../deploy/compose/Dockerfile) 仍源码构建；本地 SDK 导出不等于 npm 发布 | A 阶段，先验证发行内容与升级/恢复，再发布实际地址 |
| Console/Server 入口过大 | 基线 main.tsx 788 行、setup.tsx 1083 行、app.ts 478 行；体积属实，但 main 是演示 Console，Owner 还有独立入口 | 按真实修改热点拆页面/路由和共享安全逻辑；行数本身不设为 P0 发布阻断 |
| 配额是进程内状态 | 属实：[Core](../../apps/server/src/app.ts) 的昂贵请求共享并发 4、每用户分钟窗口 20；不是分布式预算 | 生产门槛优先项；不能只改 Map 存储而忽略租约、重试计费与公平性 |
| runtime 镜像过大 | 属实：复制完整构建目录，Server/Worker 用 tsx | 与发行产物一起处理；必须同时覆盖迁移、文档、SDK 和恢复工具 |
| Agent18 自身遥测不足 | 属实：Fastify logger 关闭；有健康诊断和持久审计，缺统一请求/依赖/模型指标 | 生产门槛优先项；默认不记录正文，审计与采样遥测分开 |
| 企业接入责任分散 | [SECURITY](../../SECURITY.md) 已记录多项缺口，但缺按场景组织的交付条件 | 本轮补公开生产门槛 |
| 启动日志固定端口 | 属实，环境 PORT 与日志可能不一致 | 本轮使用 listen 返回的实际地址 |
| CSP 含本地 demo 地址 | 属实，原策略对所有响应都包含两个 4319 地址 | 本轮仅本地配置且含演示 issuer 的 /console 保留；公开域名与独立支持页均使用 self |
| “external write 只执行一次” | 应限定为本地防重与上游幂等合同，不能推出网络传输恰好一次 | 文案写清 SaaS 事务化回执、不确定状态与只读核对 |

版本和文档漂移会直接误导接入，是本轮优先处理项。分发、配额、遥测和远程工作台影响生产适用范围，需要各自的设计与验证；拆文件则跟随这些修改推进，保持现有授权与状态边界。

## 功能建议逐项处理

| 建议 | 当前基础 | 设计决定与验证重点 |
| --- | --- | --- |
| 1. 统一能力注册表 | [Provider/Tool 合同](../reference/providers.md) 已有审核、版本、效应和范围；业务 Query/Action 有独立注册与执行器 | 采纳统一元数据和目录视图，保留不同执行入口。登记不等于可调用；撤销/漂移/角色检查不能被通用 invoke 绕过 |
| 2. MCP 作为 Transport | 现有合同区分领域和 transport，未提供通用生产 MCP 连接器 | 采纳。接入一个实际 MCP 工具时另做 schema、凭据、scope、输出裁剪和调用边界验证 |
| 3. 更多只读协议 | [QueryService](../../packages/actions/src/queries.ts) 与 OpenAPI 导入只支持受限 GET | 优先适配真实目标项目的 POST 查询。Owner 固定 URL、方法、操作、schema 与字段；自由 GraphQL 文本不可交给模型生成执行 |
| 4. 语义上下文与事件 | [SDK](../../packages/web-sdk/src/index.ts) 有 setContext；已识别当前实体，可附页面错误和 traceId | 优先增强 route/operation/event/version 与过期清理。先做明确失败事件和“当前对象”场景，SDK 事件只是线索 |
| 5. 证据关联 | [观测运行](../../packages/application/src/observations.ts) 有 Case、trace 线索、日志、指标与报告；无完整 Trace 查询 | 采纳，先一个真实 Trace 后端。关联必须记录来源、时间和验证状态；时间相近不代表因果 |
| 6. 暂缓自动代码修复 | 当前仅规划，未接编码或 PR 执行器 | 采纳。先可靠证据交接，再修复建议与隔离测试，最后带审批的草稿 PR |
| 7. 远程客服工作台 | [本地工作台](../../apps/setup/src/main.ts) 可回复工单、查看工程证据，但只有 Owner 本地访问码 | 优先按真实团队接入。另建 Operator 身份、项目角色、分配和内部备注合同，不能公开代理现有本地服务替代 SSO |
| 8. Webhook/Event API | [Dispatcher](../../packages/application/src/dispatch.ts) 有任务 outbox，没有面向外部系统的投递合同 | 采纳可靠事件出口，先连一个工单系统。签名、至少一次投递、幂等去重、乱序和回环防护先于连接器数量 |
| 9. 审核的 Workflow | 已有 Run/Step，但不是通用多步业务事务执行器 | 有条件采纳。定义确认点、补偿和最终验证；数据库 Run 不应直接获得业务写入调度权 |
| 10. 多级风险与审批 | 业务写均明确确认；工程工具有风险声明与三态 Policy，无完整用户二次认证/双人审批 | 采纳高风险约束扩展。保留写操作确认默认值，不能因为标为 low 就静默放宽 |
| 11. 多种 IdentityAdapter | [Token 验证](../../apps/server/src/auth.ts) 当前静态 Ed25519 JWKS 和固定 issuer/audience | 优先文档化 SaaS 服务端 token exchange；remote JWKS 缓存/轮换与 OIDC 需要独立实现、撤权和降级测试，不能声称已原生兼容某身份产品 |
| 12. 租户自动登记 | [项目配置](../../scripts/lib/project-config.ts) 手动写入可信租户集合 | 采纳管理凭据下 provisioning 或可信 resolver；首次 Token claim 不能自动授权新租户 |
| 13. 知识插件与检索后端 | [知识 pipeline](../../packages/knowledge/src/indexer.ts) 有扫描、构建、引用、发布，默认本地/PG | 以大仓库实测缺口选择一个解析器或后端；优先来源 ACL、覆盖率、撤权和引用质量，避免先规定一套无人实现的插件层 |
| 14. 知识缺口学习 | 巡检/排查可生成内部草稿，未按用户问题持续聚类 | 与持久 Conversation、人工回复和检索失败信号一起交付；保持受众隔离、审核发布 |
| 15. 评测集 | 有合成系统测试，无业务问答质量基线和发布前候选对比 | 优先为真实接入建立小型标注集，覆盖引用、拒答、路由/参数和权限；后续做跨版本、模型与检索器比较 |
| 16. 持久 Conversation | 普通聊天在浏览器内存；Case/消息/操作提案已持久化 | 优先补跨刷新会话；与保留、删除、身份切换和历史权限一起设计，不能只保存整段消息 JSON |
| 17. SDK 与框架 DX | [Web SDK](../../packages/web-sdk/src/index.ts) 无框架，已有浮窗/内嵌/独立页及示例后端 | 先补真实参考集成、公共导出和契约验证，再按复用需求提供 React/server 包；保留不同后端实现的自由 |
| 18. 镜像和初始化 CLI | pnpm start、setup 向导和源码 Compose 可运行；无官方公共发行地址 | 采纳，但先完成可重复发行和干净环境验收；CLI 应复用现有初始化合同，不能另外维护一套配置格式 |

优先顺序是判断，不是对评审分数或版本安排的照搬。A/B/C 阶段及生产门槛见[公开路线图](mvp-roadmap.md)。每轮选择一个可运行的真实场景，同时完成允许、拒绝、未知和恢复路径。

## 下一轮建议验收的场景

选择一个真实 SaaS 的订单或发票详情页，沿用现有登录：进入页面 → 询问当前对象 → 读取授权数据 → 确认修改一个低风险字段 → 原页面回读 → 制造受控失败 → 上报页面与 trace 线索 → 工作人员定位上游证据并回复 → 将处理方法形成待审核知识。

从这条路径记录缺口：若现有读 API 是 POST，先做查询适配；若用户无法继续对话，先做持久 Conversation；若客服无法异地处理，先做 Operator 身份；若证据无法定位请求，先做 Trace。真实阻塞决定功能顺序。

验收同时记录未配置模型、无日志、缺 Trace、对象撤权、跨租户、重复确认、上游超时和 Worker 重启。不能以助手说“完成了”替代业务状态与回执，也不能以 CI 通过替代目标系统上线验收。

## 本轮交付边界

本轮落实定位文案、中英文能力表、文档与 CHANGELOG 整理、公开路线图、文档一致性检查，以及启动日志和 CSP 修复；保持版本 0.7.0，变更记入 Unreleased。没有新增公共镜像/npm 发布、远程 SSO、持久普通会话、POST 查询或 Trace 连接器。

`pnpm docs:check` 检查版本、生成区块、实现路径存在和维护文档本地链接；不会自动判定一个功能语义正确。新增能力仍须带场景验证，历史综述保留版本语境。
