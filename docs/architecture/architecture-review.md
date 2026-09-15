# agent18 架构评审稿

历史状态：**已确认开始开发 / M0 基础链路实现中**。日期：2026-09-14。

本页保留初始设计和当时的选型讨论。当前实现以[0.7 运行机制](../overview/agent18-0.7-operations.md)和[能力现状与路线图](../planning/mvp-roadmap.md)为准，不能将下面的目标架构视为已实现能力。

本稿覆盖用户要求的 Phase 1–6；用户已授权进入 Phase 7，并确定名称 agent18。以下内容仍描述目标架构，实际已实现范围与测试证据见 [M0 实施记录](../development/m0-foundation.md)。第三方事实来自[当日组件核验](../research/component-evaluation.md)，没有将官方文档核验描述成部署或联调成功。

## 1. 产品边界：在成熟 SaaS 上增加支持与调查能力

产品是一层可嵌入的支持与工程协作平台。Core 对 Case、证据、权限决定、调查进度与审批负责；业务事实由原 SaaS 负责，遥测由现有可观测性系统负责，源码与变更由 Git 和 CI/CD 负责。

最小接入点是 Widget 或 Headless API。一次普通问题可以在知识或业务查询阶段结束；只有出现异常、证据不足或用户主动报告问题，才建立调查。Case 是贯穿链路的领域对象，不能强迫每条 FAQ 都启动工程 Agent。

| 边界 | Core 负责 | 外部系统继续负责 |
|---|---|---|
| 客服 | 会话关联、引用答案、升级、人工接管状态 | 现有坐席、邮件、渠道与工单工作流 |
| Knowledge | 来源登记、授权范围、版本与引用、查询编排 | 文档编辑、复杂解析、OCR、向量检索 |
| Business | 候选工具审核、用户身份传递、安全投影 | 业务校验、实体归属、订单/发票/支付状态 |
| Runtime | 限定 Case 的查询、证据关联、调查缺口 | 日志存储、Trace 存储、指标、告警与运维控制台 |
| Engineering | 证据支持的提案、Sandbox 任务与结果审核 | Coding Agent、Git、代码评审、CI/CD |
| Governance | 授权、范围、审批、审计、发布给客户的内容 | 企业 IdP、Secret Manager、组织治理流程 |

不在首版开发全渠道客服、完整 CMDB、全量日志平台、通用 Agent IDE、完整 RAG 引擎、图数据库、自动生产修复和几十个 Connector。Living Documentation 首版只留 Proposal 类型，后续增加差异检测；不得静默改正式文档。

### 渐进接入合同

| 等级 | 客户要提供的最少输入 | 解锁能力 | 缺少下一层时的行为 |
|---|---|---|---|
| L1，目标 15 分钟 | 已可访问的平台、模型配置、公开 Markdown/Website、SDK 或 Headless API | 引用式知识回答、问题报告 | 无身份时只查 PUBLIC；可建立匿名报告，不查询业务 |
| L2，目标半天 | SaaS 后端签发 Support Token；前端实体上下文 | 用户/客户租户隔离、My Cases、页面与实体关联 | 浏览器自报 tenant/user 不能解锁权限 |
| L3，目标 1 天 | 精选 OpenAPI 操作、身份桥接和后端租户校验 | 用户可见业务查询、基于业务规则的异常升级 | 不满足租户隔离的接口保持禁用 |
| L4，目标几天 | 已有 Trace/Log 查询端、服务和部署映射、Git | Runtime → Deployment → Source → RCA | 缺失 Trace、Commit 或服务映射必须显示调查缺口 |
| L5 | 隔离 Sandbox、Coding Provider、GitHub 写权限与审批人 | Patch、测试、审批、PR | CI、合并和生产发布仍由现有流程执行 |

这些时间是接入体验目标，不是尚未验证的 SLA；不包含新建客户知识体系、改造其身份系统、部署全部第三方产品或打通企业网络。自托管冷启动和 SDK 接入耗时分别测量。

“Connect”允许可撤销的检索索引和少量证据缓存，不改变外部系统的权威地位。客户关闭复制时，使用外部查询 Provider；无法保留证据快照时，明确其后续可复现性限制。

## 2. 推荐系统架构

推荐 **TypeScript 模块化单体 + 独立 Worker + PostgreSQL + OPA**。Console 静态资源由 Server 提供；本地基础版无需 Redis、Kubernetes、图数据库或独立向量数据库。M3 开启工程写入时再启动独立 Executor 与临时 Sandbox。

[系统架构图](system-architecture.drawio) · [信任边界图](trust-boundaries.drawio)

| 部分 | 推荐技术/部署 | 选择理由 |
|---|---|---|
| Web SDK | 框架无关 TypeScript；Widget 懒加载到独立 iframe | 不要求客户使用 React，不污染宿主 CSS，不依赖第三方 Cookie |
| Console | React + Vite，静态 SPA；由 Core API 提供数据 | 后台无需 SSR；便于独立部署和未来局部嵌入 |
| Core API | Node.js 受支持 LTS + Fastify + TypeScript | 同语言共享契约，模块边界明确，HTTP/OpenAPI 优先 |
| 契约 | JSON Schema + OpenAPI；生成客户端 | Core API 的 Schema 来自受控仓库；导入客户 OpenAPI 单独处理 |
| 主存储 | PostgreSQL，显式 SQL migration、事务和 RLS | 关系、隔离、JSONB 扩展、版本与审计统一 |
| 异步工作 | pg-boss + Run/Step 持久化 + Transactional Outbox | 复用队列，避免基础版增加 Redis；不是自造消息中间件 |
| Policy | 独立 OPA，版本化 Rego bundle | 非 LLM 授权；出错关闭能力；Core UI 编辑受控模板参数 |
| Artifact | CE 私有文件卷；生产可换 S3 兼容存储 | 小规模低运维；文件下载永远经过授权 |
| 模型接入 | ModelProvider；各模型的官方 SDK/受控 HTTP Adapter | 支持客户已有模型网关；不假设所有厂商完整兼容同一种 API |
| Coding | 外部 OpenHands Software Agent SDK / Agent Server | 不将 Python Agent 引擎搬入 TypeScript Core |
| 工程发布 | 独立 Executor；GitHub App 安装令牌 | 凭据与不可信代码隔离，动作可审核、可核对 |

pg-boss 是已有 PostgreSQL 作业队列，可以降低部署依赖；外部 HTTP、PR 等副作用仍按**可能重试**设计，不能把队列的交付语义当成外部操作 exactly-once 保证。[pg-boss 官方仓库](https://github.com/timgit/pg-boss)

### 部署与进程边界

基础 Compose 长驻四类容器：Server（含 Console）、Worker、PostgreSQL、OPA。TLS 可使用客户已有反向代理。RAGFlow、Langfuse、OpenHands、OTel Collector 和演示可观测性系统使用可选 profile。

Server 包含可信 Policy Gateway、经过审核的内置 Provider Adapter 和 SecretProvider；Worker 只提交结构化请求，通过受认证的内部 API 执行工具。Worker 不持有客户后端、Git 或基础设施凭据，不连接客户网络，不直接读业务表/审批表。pg-boss 的 Worker 数据库角色只可访问作业 schema，作业正文只保存标识符；业务读写走授权 API。

这意味着“模块化单体”描述的是业务代码组织；不意味着 Agent、第三方代码和生产凭据共用一个进程。Core 不动态加载客户提交的插件代码；外部 MCP Server 独立运行。

M3 Executor 使用另一个系统身份与网络域，只接收批准的 Action ID，重新加载其不可变内容，不信任调用方提交的状态。Sandbox 与 Core/Executor 不共享主机目录、数据库凭据或容器管理 socket。生产运行时动作默认没有可用 Handler。

### 同步、异步与事件

1. SDK 提交消息/报告，Server 验证身份、去重，事务中保存 Conversation/Case 和 Outbox。
2. Dispatcher 将待办投递至 pg-boss；重复投递通过事件 ID 与 Step 幂等键消除。
3. Worker 获取 Run，执行有限状态的工作流；每一步保存输入引用、结果引用、策略决定、失败类型与 checkpoint。
4. 调用工具或模型必须经过可信 Gateway；参数规范化、授权、预算和输出投影先于 Agent 使用。
5. Console 通过 SSE 接收进度，断线后按事件序号续读；HTTP 读取当前快照始终可用。
6. 人工接管、等待授权、Provider 限流、取消和进程重启都可恢复；等待审批不占用持续运行的 Agent。

事件使用 CloudEvents 兼容 envelope，领域事件例如 `case.created`、`run.step.completed`、`proposal.created`、`approval.recorded`。事件包含租户范围、对象 ID、版本和关联 ID，禁止携带 Secret 或完整日志。不引入全量 Event Sourcing；业务表是状态来源。

## 3. 开源复用决定

逐项版本、API、SDK、许可证与维护证据见[组件评估](../research/component-evaluation.md)。选型结论如下：

| 组件 | 采用方式 | 首版位置 |
|---|---|---|
| OPA | 默认 PolicyProvider；独立进程 | M0/M1 必选，权限能力不能是付费附加项 |
| OpenTelemetry | SDK/Collector 与语义规范 | 平台自身观测；M2 接客户已有遥测 |
| RAGFlow | 外部 KnowledgeProvider，优先调用 retrieval 而非接管完整 Agent | 推荐复杂文档 Provider，基础版不强制部署 |
| OpenHands | CodingAgentProvider，使用 SDK/Agent Server | M3 首个 Coding Provider |
| Langfuse | Trace / Evaluation exporter | 可选；Core 仍保留 Run 与安全审计事实 |
| Loki | 受限 LogQL 的 ObservabilityProvider | M2 首个日志 Adapter |
| OpenObserve | 现有客户可观测性 Provider；Demo 补 Trace/Metric 查询后端 | M2 只实现 Demo 所需查询面 |
| Sentry | 现有实例的只读 API Integration | 后续，不作为 Core 内嵌依赖 |
| Cedar | PolicyProvider 的替换候选 | 首版不同时维护 OPA 与 Cedar 两套规则 |
| Chatwoot | Headless 接入参考与首个完整客服 Connector 候选 | M1 留合同测试，M3 可选真实接入 |
| MCP SDK | 官方 Client/Server SDK，受控工具目录 | M1 受限 Client；Core 对外 MCP 接口后续 |

补充关键缺口：**OTel 不是 Trace 查询数据库，Loki 不是完整分布式 Trace 后端**。必须使用客户已有的 OpenObserve、Tempo、Jaeger 或其他支持查询的 Trace 系统。M2 Demo 选择 OpenObserve 提供 Trace/Metric 查询，并保留 Loki 日志 Adapter；客户不用为 agent18 迁移后端。[OTel 部署文档](https://opentelemetry.io/docs/collector/deploy/) · [Loki API](https://grafana.com/docs/loki/latest/reference/loki-http-api/) · [OpenObserve API](https://openobserve.ai/docs/reference/api/search/)

## 4. 自研核心模块

| 模块 | 核心产物 | 不能越界的部分 |
|---|---|---|
| Identity & Access | Project 绑定、用户映射、客户租户、操作者成员关系 | 不再做一个 IdP |
| Support | Conversation、Message、人工接管、Case 升级 | 不做邮件/电话/渠道运营平台 |
| Case | 生命周期、参与者、范围、关联会话与服务 | 不替代客户业务数据库 |
| Context Correlation | 可追溯的节点、边、时间、置信依据 | 不做通用知识图谱/CMDB |
| Service Catalog | Runtime、Telemetry、Source、Owner 的确认映射 | 不扫描整个企业资产 |
| Evidence | 授权查询、清洗、引用、快照、来源与时间 | 不保存全量原始遥测 |
| Investigation | 可恢复的 Run/Step、调查缺口、停止条件 | 不做无限递归万能 Agent |
| Hypothesis / RCA | 支持证据、反证、验证状态、未知项 | 不把模型自信度当事实 |
| Proposal / Approval | 方案、风险、回滚、审批与失效规则 | 不绕开代码评审与 CI/CD |
| Policy Gateway | 每次工具调用的权限与输出约束 | 不用 LLM 判断权限 |
| Executor | 注册的结构化动作 Handler、幂等与事后核对 | 不接受任意 shell/SQL/自然语言命令 |
| Customer Projection | 对外字段白名单、引用授权、公开结论 | 不把内部报告整段交给模型改写后直接发出 |
| Audit | 决定、审批、执行与结果的关联记录 | 不用可采样 LLM Trace 代替审计 |
| Integration Registry | Provider 配置引用、工具注册、健康/版本/能力 | 不实现新的互联协议 |

## 5. Trust Boundary 与 Security Model

### 5.1 身份分为三类，业务租户与平台组织分开

`Organization` 表示运营此平台的 SaaS 公司；`Project` 表示其某个 SaaS 产品；`Tenant` 表示该产品服务的客户组织。客户租户键至少为 `(organization_id, project_id, external_tenant_id)`。同一个 SaaS 公司多个产品中出现相同 tenant 字符串，不能因此共享数据。

- **CustomerPrincipal**：SaaS 后端证明的最终用户身份和业务可见范围。
- **OperatorPrincipal**：客服/SRE/工程师，通过 Console OIDC 和项目成员关系授权。
- **WorkloadPrincipal**：Worker、Connector、Executor 的系统身份；不继承管理员权限。

业务系统中的 `role=admin` 仅表示该客户租户内管理员；不能转换成 agent18 管理员、审批人或 Engineering Agent 权限。Support Token 不是通用 SSO ID Token，也不是可以转发给所有后端的全能 Bearer Token。

### 5.2 Support Token 与浏览器边界

建议复用签名 JWT 与 JWKS：验证允许的算法、签名、`iss`、`aud`、`exp`、`nbf`、`sub`、project 绑定、最大有效期及密钥轮换。默认短时有效，具体 TTL 可配置。`userId` 可映射到标准 `sub`，tenant/role/scope 采用受控应用 claims。

JWKS URL 由项目管理员配置，禁止从 Token 的任意 URL 动态加载。`projectKey` 是公开路由标识，不能当凭据。浏览器携带的 tenant/user/role 只作未验证提示，不能覆盖已经验证的 Principal。

查询业务时优先做受众限定的 OAuth Token Exchange / 用户委托；旧 SaaS 可以增加一个很薄的服务端 Support Bridge，验证用户、实体归属并执行租户限定查询。不把 Support Token 原样转发给未指定受众的后端，不使用全局 Admin API。[OAuth Token Exchange 标准](https://www.rfc-editor.org/rfc/rfc8693)

匿名模式只访问该 Project 明确发布的 PUBLIC 知识。匿名 Case 的访问凭据由服务端生成并绑定会话；用户登录后通过后端验证归并，不能凭 Case 编号认领。匿名会话与已识别客户会话不能混用检索缓存。

### 5.3 权限模型：主体、代理类型、对象范围共同约束

| 能力等级 | Customer Agent | Investigation Agent | Engineering Agent | 实际执行者 |
|---|---|---|---|---|
| L0 客户可见知识 | PUBLIC / 授权 CUSTOMER / 当前 TENANT | 按操作者与 Case 授权 | 按任务授权 | Knowledge Adapter |
| L1 业务读取 | 用户与租户范围内 | Case 授权的受限业务投影 | 默认无额外业务权限 | Business Adapter + SaaS 后端 |
| L2 Runtime / Source READ | 禁止 | 有有效 Case Capability 才允许 | 当前任务指定 repo/commit 的只读上下文 | 只读 Provider |
| L3 Sandbox 写入/测试 | 禁止 | 默认禁止写入 | 仅当前 Sandbox 的局部文件和测试能力 | 隔离的 Sandbox Tool Runtime |
| L4 生产写入 | 禁止 | 只能提案 | 只能提案 | 后续独立 Executor，人工审批 |
| L5 Secret / IAM / 删除数据库 / 改审计或策略 | 禁止 | 禁止 | 禁止 | 不提供 Agent Handler |

权限等级不是“等级高便拥有全部低等级权限”。Engineering Agent 不自动得到所有租户业务数据；工程角色也不自动获得生产写权限。

`PUBLIC / CUSTOMER / TENANT / INTERNAL / ENGINEERING` 不是可简单比较大小的枚举：它们结合 `audience`、`allowed_tenants`、文档 ACL、角色和用途一起判断。Customer Agent 不得读取 INTERNAL 或 ENGINEERING。默认 CUSTOMER 仅面向已认证且获授权客户；TENANT 必须匹配当前客户。

### 5.4 Case-scoped Capability

尚未升级为 Case 的 L0/L1 查询使用已验证 Principal 与 Conversation Scope，不要求为每次 FAQ 伪造 Case。L2 Runtime、工程源码调查及之后的动作必须绑定实际 Case。知识同步等非 Agent 后台维护作业使用单独的 Integration 管理授权，不继承客户会话权限。

Capability 是后端持久化的授权记录；Agent 只持有不可猜测的引用，不让 LLM 编写 Token 或修改权限内容。内部服务身份用标准认证；引用本身不构成充分授权。

有效权限 = **Principal 权限 ∩ Project 策略 ∩ Case Scope ∩ Tool 限制 ∩ Integration 能力 ∩ 本次审批条件**。

约束至少包括 organization、project、tenant、agent kind、caseId、environment、service IDs、repository IDs、时间窗口、工具集合、字段集合、返回量、预算、过期时间、policy version、scope revision。Scope Expansion 生成独立请求与新修订版，旧 Capability 失效；默认不允许跨客户租户扩张。

Case 关闭、授权撤销、成员变更、集成断开或 scope 变化后，每次调用都会重新检查；队列里已有任务和长期等待审批不能绕过撤销。所谓“Case 自动关联到某服务”只是调查线索，不自动增加对该服务的授权。

WorkloadPrincipal 还要绑定 Server 签发的 Run lease，Gateway 校验作业分配、run/case/capability 关系；Worker 知道另一个 Case ID 也不能任意调用。用户委托 Token 过期后，用户业务查询必须重新获得有效委托；转入后台调查需要预先配置的独立支持调查授权，不能把过期用户权限悄悄变成长效服务权限。

### 5.5 Tool Gateway 与 OPA

处理顺序：认证 → 解析受控 Schema → 从服务端补全权威 Scope → 校验资源归属 → OPA 决定 → 保存决定审计 → 调用受限 Adapter → 校验归属与输出 Schema → 脱敏/裁剪 → Evidence → Agent。

OPA 输出设计为 `decision + reasonCodes + obligations + policyRevision`。`ALLOW / DENY / APPROVAL_REQUIRED` 是本平台的决策结果契约，审批状态机由 Core 实现；OPA 不会天然替我们完成审批。Obligations 可要求字段投影、最大时间窗口或返回量；Adapter 不支持某项强制约束时拒绝调用。

策略是 Rego，不发明 Policy DSL。权限矩阵 UI 修改受限模板参数；高级策略修改由授权管理员提交版本并通过策略测试。LLM 不能调用策略管理接口。OPA 不可用、返回 undefined、结果格式错误或 bundle 不可验证时关闭对应工具，不切到默认允许。[OPA REST API](https://www.openpolicyagent.org/docs/rest-api)

MCP 工具名、说明、`readOnlyHint` 等 metadata 都不具有授权效力。注册时审核并固定工具描述/Schema 的摘要；上游变化后重新审核。所有执行入口，包括内部 Agent、MCP、OpenAPI、人工发起的动作、Coding Agent 工具，都走同一授权边界。

### 5.6 数据隔离、Secret 与 Prompt Injection

- PostgreSQL 使用 RLS、非表所有者应用角色与 `FORCE ROW LEVEL SECURITY`；角色无 `BYPASSRLS`。事务内设置已验证组织/项目/租户范围，连接复用时不能遗留身份。
- 外键/唯一键包含所属组织和项目；Case Evidence 关联必须匹配 Case 所有权。客户作用域和内部运维作用域使用不同的受控数据库会话，不以空 tenant 作为全库通配符。
- Cache、索引、对象存储路径、队列、导出、搜索建议、分页统计、SSE、Webhook、Langfuse 标签均保持同样的隔离。检索必须在搜索前过滤，再校验返回数据；不能先全局检索，把泄漏寄希望于生成后的过滤。
- SecretProvider 只向可信 Adapter/Executor 注入临时凭据。Core DB 保存 `credentialRef`，不保存明文；基础版用私有 Secret 文件，企业版接已有 Secret Manager。禁止 Secret 进入 Prompt、Tool Result、Run、Audit、Exception 或导出的 Trace。
- 日志先查询约束、字段白名单与长度限制，再做 credential/PII 清洗。优先上游不采集敏感字段；正则脱敏无法证明所有未知格式都已清除。无法安全投影的响应拒绝送往 LLM。
- 客户消息、文档、日志、源码、网页和工具说明全部是数据。Prompt 分离和注入检测只是辅助；真正的权限由 Gateway、数据库、网络和进程隔离执行。
- 模型供应商也是数据处理边界：按 Project 配置数据地域、保留策略、可发出的分类和模型；没有外发许可时只允许批准的本地模型/网关，不能自动切到公网模型。

PostgreSQL 的表所有者与超用户可以绕过通常的 RLS 行为，因此 RLS 必须与数据库角色边界一起设计。[PostgreSQL RLS 文档](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

### 5.7 Approval 与 Executor

审批绑定 **Action 内容摘要、工具/Schema 版本、Project、Case scope revision、目标资源、environment、repo/base SHA、patch digest、测试 Artifact、过期时间、审批规则**。审批动作前展示具体 Diff、测试、风险和回滚；修改任意重要输入后重新审批。

审批人必须有独立 Operator 权限；不能由 Customer Token、Agent 或请求方自证审批资格。高风险支持双人不同主体审批；审批关系、有效期和职责分离在执行时重验。

Executor 仅接受 Action ID，原子抢占执行权，重验策略、审批、资源版本和前置条件，再取得目标凭据。网络超时导致结果未知时进入 `RECONCILING`，查询外部系统确认后再决定重试，避免重复 PR 或重复操作。失败与补偿也进入审计。

首版只注册 `github.create_pull_request` 等明确 Handler。PR 创建本身是外部写操作；Agent 产出 Patch/测试，经过人工审批后由 Executor 发布分支和 PR。拒绝/过期审批不创建 PR。PR merged 与生产 resolved 是不同事实，必须另有 CI、发布和运行验证。

后续即使增加重启/回滚，仍不接受任意 shell、`kubectl` 字符串或自由 SQL；危险能力保持无 Handler。生产写开关不是用户升级到 L5 后自动打开的能力。

### 5.8 Customer-safe Projection 与 Audit

内部 RCA 不能原样发给客户，也不能仅靠另一个 LLM“润色”。先构造单独的 `CustomerCaseView / CustomerFinding`，只包含允许的症状、进度、影响、用户可执行步骤、对外说明和授权引用；不携带内部 IP、Pod、Commit、内部文档标题或日志片段。需要公开新的事实时由授权人员批准发布副本。

客户答案只引用当前用户可访问的文档版本；每次下载引用重新授权。模型可在安全 DTO 上改善措辞，不能扩大可见字段。

审计至少记录 actor、agent、organization/project/tenant、case、run、step、tool/action、resource、参数摘要、policy revision、decision/reason、approval、result、timestamp。ALLOW、DENY、APPROVAL_REQUIRED 与调用失败都记录；拒绝请求中的 Secret 不直接落审计。

应用身份只有 append 权限；审计服务由数据库生成序号/时间。哈希链可辅助检测修改，但不能抵御掌握数据库的管理员；强不可篡改需求通过客户外部 WORM/审计系统锚定。保留与删除由独立治理流程执行，Agent 无权修改。安全审计写入失败时禁止执行受保护工具与外部写操作。

## 6. Provider / MCP / Agent / Context 架构

### 6.1 Provider 定义能力，MCP 提供一种调用方式

Provider 是 Core 的类型化接口与适配边界，不是一套新网络协议。一个 GitHub Integration 可以同时实现 SourceProvider 和 TicketProvider，但每项工具权限独立。REST/GraphQL 已适用时直接通过 Adapter 调用，不为统一外观额外搭一个 MCP Server。

| Provider | 最小接口语义 | 特别要求 |
|---|---|---|
| KnowledgeProvider | search、getCitation、syncStatus | 返回授权范围、文档版本、片段位置、ACL 与 freshness |
| ObservabilityProvider | searchLogs、getTrace、queryMetrics、getErrors | 按能力发现；不要求每家实现全部信号 |
| RuntimeProvider | getDeployment、getWorkload | Kubernetes/CI 发布记录；禁止 Secret、exec、集群级任意读取 |
| SourceProvider | readFileAtCommit、compare、history | 绑定 repo ID 和完整 SHA，不使用浮动分支证明事故时源码 |
| BusinessToolProvider | discoverCandidates、invokeApprovedRead | 后端用户/租户强制校验、字段投影 |
| CodingAgentProvider | start、status、cancel、artifacts | 异步任务、隔离 workspace、Patch 与测试证据 |
| TicketProvider | link、createProposal、syncStatus | Jira/GitHub Issue 等工程工单；外部写入需 Action |
| SupportProvider | normalizeInbound、handoff、publishReply | 客服会话、消息回写和人工接管；防回环 |
| IdentityProvider | verifySupportToken、resolveOperator、delegate | Customer / Operator / Workload 不混用 |
| PolicyProvider | evaluate | OPA 默认；固定决定 Schema 与策略修订版 |
| SecretProvider | resolveForExecutor、revoke | 只对可信代码可用；不向 Agent 暴露获取 Secret 的 Tool |
| ModelProvider | generateStructured、stream、usage | 供应商能力/地域/数据分类/预算限制 |
| ArtifactStore | put、getAuthorized、expire | 不接受任意路径或公共桶；按 Case 与内容分类隔离 |

共用的 Provider 执行上下文由 Gateway 生成：Principal、Case Scope、deadline、字段投影、最大行数/字节数、取消信号、correlation ID。LLM 能填写工具的业务参数，不能重写这个执行上下文。

Provider 返回结构化结果，包括 `status`、`items/artifactRefs`、`sourceRefs`、`observedAt`、`schemaVersion`、`truncated`、`nextCursor`、`warnings`。标准错误分类至少有 `UNSUPPORTED / UNAUTHORIZED / RATE_LIMITED / TEMPORARILY_UNAVAILABLE / INVALID_SCOPE / NOT_FOUND / PARTIAL`，防止把“未接入/无权限”误报成“没有故障”。

所有注册项都说明支持的 API/协议版本、可用能力、授权方法、Scope 强制能力、超时、限流、数据地域。连接健康与工具授权状态分开展示：Connected 不代表该 Agent 可调用。

### 6.2 MCP 的实际落点

`Agent → Gateway → OPA → MCP Client Adapter → 客户批准的 MCP Server → 目标系统 → 受限 Evidence`。

基准采用当前 **2026-07-28** 协议，使用官方 SDK，并在 Adapter 内兼容客户已有 2025-11-25 服务。当前版使用逐请求版本声明和可选 `server/discover`；不能把旧版 initialize/session 生命周期硬编码进 Core。Tasks 扩展不作为 Core Run 持久化的前提。[当前规范版本](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) · [SDK 迁移说明](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

Remote MCP 优先 Streamable HTTP + 规范要求的 OAuth/HTTPS，按 authorization server/resource/organization 隔离凭据。SDK 新安全要求有显式启用项，升级依赖并不等于自动满足规范。Sampling、elicitation、资源 URI 和动态工具变化按能力白名单处理；默认不能借 sampling 访问未经许可的模型。

本地 stdio MCP 只允许管理员部署的固定程序，在独立隔离进程运行；客户提交 URL、README 命令或包名不能触发 Server 安装执行。Registry 是发现机制，不是安全认证。只接受核验过的服务域名、工具版本和访问能力。

### 6.3 OpenAPI / GraphQL / HTTP Tool 导入

导入只生成候选工具，不自动授权。必须人工确认操作语义、输入/输出 Schema、身份传递、资源所有权校验、环境和风险；GET 也可能有副作用，HTTP 方法不足以定义安全性。

导入器固定 base URL 和受控路径模板；禁用默认远程 `$ref`，限制 Schema 大小、深度与正则复杂度；不允许参数覆盖 host、Authorization 或 tenant header。所有跳转、DNS 解析和请求目标都受 egress allowlist 限制。私网 API 通过管理员配置的特定 Connector 访问，不通过通用 HTTP 工具任意探测内网。

Fastify 的验证/序列化 Schema 可能生成代码，因此不能把客户上传的 OpenAPI 直接注册成 Core 路由 Schema。导入与验证在隔离步骤中做规范化，仅允许可审计子集进入工具目录。[Fastify 安全说明](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)

GraphQL 首版只设计接口，后续使用审核的 persisted query / operation allowlist；限制深度和字段，并按 resolver 行为判断风险。不能把任意 GraphQL query 视为天然只读。

### 6.4 Agent 分工与停止条件

| Agent | 输入 | 可做的事 | 输出/结束条件 |
|---|---|---|---|
| Customer Support | 当前会话、安全知识、用户业务投影 | 解释、引用、查询、提议升级 | Answer / NeedClarification / Escalate / HumanTakeover |
| Investigation | Case、授权 Evidence、服务映射 | 有界查询、提出并验证假设、定位缺口 | RCA 候选、反证、未知项、下一步；可得出证据不足 |
| Engineering | 通过审查的 RCA/提案、限定源码 | Sandbox 内修改/测试/产出 Patch | Diff、测试结果、风险与 PR Proposal；不持有发布凭据 |
| Executor | 不可变 Action 与有效审批 | 执行已注册 Handler、事后核对 | ExternalRef / Executed / Failed / Reconciling；不是 LLM |

使用有限工作流阶段，阶段内允许有限工具选择。最大步数、工具调用数、Token、总费用、总时长、每租户并发和单次结果量都有预算。连续无新证据、缺少权限、Provider 不支持、矛盾未解决或预算耗尽时结束/交人工，不循环猜测。

Run 保存可观察的计划摘要、调用、证据和决定，不要求保存模型隐藏推理。执行中的人工接管会取消自动回答；用户补充材料产生新 Context revision 和可追踪的后续 Run，不覆盖原结论。

### 6.5 Context Correlation：关联必须带来源与时间

三类上下文统一做证据化引用：Static（文档/Schema/源码）、Historical（历史 Case/工单/Git/发布）、Live（业务状态/遥测/部署）。它们保持不同 freshness 与安全分类；不把它们合成一个无差别向量库。

关联优先级：

1. SaaS 后端验证 user/tenant/entity 所属关系。
2. 可信后端记录的 entity → requestId → traceId；浏览器上报 Trace 仅为线索。
3. Trace resource / span → service.instance / pod UID，保留 instrumentation 来源。
4. Pod UID → ReplicaSet/Deployment revision → image digest，使用事故发生时的部署记录。
5. image digest → CI provenance / release manifest → commit SHA → repository。
6. 只有名称/时间接近时生成候选关联，管理员确认或标记 inferred，不能伪装成 verified。

Context 节点边保存 `assertedBy`、`sourceRef`、`observedAt`、`validFrom/validTo`、`confidenceBasis`、`verificationStatus`。Trace ID 非授权凭据，也不是必须全局唯一的数据库业务键；同一时间存在 canary/多副本/多版本时允许多候选，不能任选“最近 commit”。

跨异步任务、消息队列、采样丢失和时钟偏移会断链：显示 `missing link`，可以退回 requestId/entity/time-window 受限调查。高基数 tenant/user 信息不默认放 Metrics label；不把 PII 通过 W3C Baggage 向第三方传播。

Service Catalog 保留 Project、service.name、环境、namespace/workload、Telemetry 映射、Source repo、Owner 和确认历史。自动发现是建议；管理员确认后生效。跨租户事故后续建内部 Incident 聚合多个 Case，不能通过合并 Case 直接互通客户数据。

## 7. 核心数据模型

使用 PostgreSQL 关系表保存身份、所有权、引用、状态和版本；JSONB 只承载受 Schema 约束的差异字段。Evidence Graph 首版用节点、边、引用表和有限递归查询，不增加图数据库。

### 7.1 实体与关系

| 实体 | 关键字段/责任 | 关系与约束 |
|---|---|---|
| Organization | SaaS 运营方、安全/数据地域设置 | 1:N Project；所有内部对象有 owner |
| Project | 产品、公开 projectKey、issuer/域名、模型设置 | 1:N Tenant、Environment、Integration |
| Tenant | externalTenantId、状态、配置 | 属于单一 Project；不是平台超级管理员域 |
| User | externalSubject、最小用户资料 | 通过 TenantMembership 加入租户；按 issuer/project 解析 |
| Operator / Membership | IdP subject、项目角色、审批权限 | 与最终 Customer User 分开 |
| Environment | dev/staging/production、策略绑定 | 属于 Project；生产默认写禁用 |
| Service / ServiceBinding | service key、Owner；runtime/telemetry/source 映射 | Service 1:N 随环境/版本变化的 Binding |
| Conversation / Message | channel、actor、visibility、外部消息 ID | Tenant/User；Conversation 与 Case 通过关联表连接 |
| Case | 编号、症状、状态、严重度、负责人、scope revision | 1:N Context / Run / Proposal；一个 Case 一个客户安全域 |
| ContextSnapshot | session/page/entity/request/trace refs、采集来源 | Case 的不可变版本；浏览器与后端字段分开 |
| ContextNode / ContextEdge | 类型、外部 ID、关联依据、有效时间 | 通过 CaseContextLink 关联，不能扩大权限 |
| Artifact | 私有存储引用、摘要、媒体类型、大小、分类、保留期 | 如证据快照、Diff、测试输出、附件 |
| Evidence | assertion、类型、时间、来源定位、Artifact、scope | 一个可核对的观察；不等于模型结论 |
| Hypothesis | statement、confidence、supporting/contradicting refs、status | N:M Evidence；保存验证历史 |
| Finding | 事实结论、可见级别、evidence refs | 支持内部与经批准的 CustomerFinding |
| RootCause | symptom、cause、验证状态、affectedScope、unknowns | 关联 Hypothesis/证据；新 Run 生成新修订 |
| Proposal | 类型、计划、测试、风险、回滚、base revision | 1:N Action；支持 patch/runtime/doc_update |
| Action | type/version、target、parameters、digest、state、idempotencyKey | 1:N Approval / ExecutionAttempt |
| Approval | action digest、approver、decision、expiry、policy revision | 不可由 Action 提议人随意替换/覆盖 |
| AgentRun / RunStep | agent kind、版本、scope、输入引用、budget、state | Case 可有多个 Run；步骤保留重试/父子关系 |
| Tool / ToolVersion | 名称、Schema、操作、风险、environment、scope、approval | 工具元数据版本化，属于受控 Integration |
| ToolPolicy | Rego bundle/template binding、参数、版本 | Project/环境/工具范围内关联，默认拒绝 |
| Integration | provider kind、endpointRef、credentialRef、owner、health | 可实现多个 Provider；客户授权/工具绑定独立 |
| KnowledgeSource / DocumentVersion | externalRef、ACL、scope、版本、sync/index 状态 | 检索片段/引用绑定不可变文档版本 |
| Capability / ScopeExpansion | Case 范围、授权主体、有效期、scope revision | Gateway 创建/撤销，不由 Agent 自签 |
| AuditEvent / OutboxEvent | 安全决定 / 待发布事件 | 分表；Audit 不参与 LLM 自动总结的原始输入 |
| ExternalLink / WebhookReceipt | 外部 Case/会话/PR 映射、投递去重 | 唯一键含 Integration 和 external event ID |

Case → Evidence/Hypothesis/RootCause → Proposal → Action → Approval → ExecutionAttempt 构成主链。Incident 是后续内部聚合实体；Case 不强制代表已确认事故。知识源与 Integration 可为 Project 共享资源，但必须通过 Binding 明确允许哪些客户租户使用。

### 7.2 Case 最小字段

`id, caseNumber, organizationId, projectId, tenantId, reporterUserId, environmentId, channel, symptom, status, severity, ownerId, contextRevision, scopeRevision, createdAt, updatedAt, resolvedAt`。

匿名 Case 使用独立匿名受限主体，tenant 不明意味着“没有业务权限”，不是“任意 tenant”。`caseNumber` 只是人类可读标识，授权总是按不可猜测 ID 与主体范围校验。

状态建议为 `OPEN → TRIAGING → INVESTIGATING → WAITING_INPUT / WAITING_APPROVAL → RESOLVING → RESOLVED → CLOSED`，允许受控 REOPEN。Case 状态不代替 Run、Action 或 PR 状态；调查完成不自动代表客户问题已解决。

### 7.3 Evidence 与 RCA 最小字段

Evidence 包含 `id, caseId, kind, assertion, sourceSystem, sourceObjectId, sourceLocator, sourceVersion, observedAt, collectedAt, queryScope, classification, redactionVersion, artifactId, contentDigest, expiresAt, verificationStatus`。源码定位包含 repo/SHA/path/行范围；日志定位包含 backend/stream/time/request 或 trace；文档定位包含 source/version/section。

保留实际用于判断的脱敏片段摘要与快照。没有原始保留许可时只留授权引用，标记 `reference_only`；来源失效后不能声称可以完整回放。`NOT_FOUND`、`REDACTED` 和 `UNAVAILABLE` 必须区别。

Hypothesis 必须有 `statement, confidence, supportingEvidence[], contradictingEvidence[], status`；额外记录 `verificationSteps, unknowns, evaluatedBy`。状态至少 `PROPOSED / SUPPORTED / CONTRADICTED / VERIFIED / INCONCLUSIVE`。

RootCause 结构至少包括 Symptom、Runtime Evidence、Trace、Deployment、Commit、Affected Code、Hypotheses、支持/反对证据、Cause、Confidence、Affected Scope、Suggested Fix、Tests Required、Risk、Rollback Plan、Unknowns。Markdown 只是导出视图。

Confidence 同时记录依据与验证状态。`0.92` 只能是模型/规则评分，未经标注评测不能称“92% 正确率”。采样导致没搜到错误日志也不是排除假设的充分反证。确定根因需要与声明强度相匹配的复现、对照、稳定证据或人工确认。

### 7.4 Tool / Policy / Action

Tool 元数据至少包含：`name, version, integrationId, providerCapability, inputSchema, outputSchema, operation(READ/WRITE), stage(READ/PROPOSE/EXECUTE), risk, environments, scopeKinds, approvalMode(none/required/dual), allowedAgents, timeout, maxResultBytes, idempotencySupport, schemaDigest`。

WRITE 表示实际副作用；PROPOSE 仅创建内部 Proposal，不拥有执行语义。Sandbox 写、GitHub PR 写、生产写具有不同目标和策略，不能只用一个笼统的 WRITE 开关。

Action 状态：`PROPOSED → WAITING_APPROVAL → APPROVED → EXECUTING → EXECUTED`，分支为 `REJECTED / EXPIRED / CANCELLED / FAILED / RECONCILING`。审批只改变批准状态，执行后要核对外部事实；适用时保存资源版本、PR ID 与检查结果。

## 8. 前后端页面与 API 模块

### 8.1 前台 SDK

Widget 包含 Ask AI、Report a Problem、Help、My Cases，支持隐藏 Widget 仅用 Headless API。宿主只提供 `init / setContext / reportProblem / destroy`；`getIdentity` 懒加载/刷新短时 Token，SDK 不保存 SaaS 主会话凭据。

默认采集 route 模板、URL origin/path 的清洗值、随机 sessionId、appVersion、locale、timezone、浏览器概要与时间。URL query/fragment、请求/响应正文、Authorization、Cookie、localStorage、DOM 和截图不默认采集。

前端错误与 failed request 只留清洗后的类型、status、允许的 requestId/traceId、受控 URL 和短摘要；保留有限环形缓存、限速与 TTL。网络监控 opt-in，优先接客户已有 instrumentation hook；不默认全局覆写 fetch/XHR，不向任意跨域请求注入 trace header。

截图需要显式选择、预览、敏感区域处理和上传限制。iframe 的 postMessage 验证 exact origin/source 和 Schema；Token 仅内存传递，不放 URL。支持 CSP、Keyboard/Screen Reader、宿主样式隔离、移动端和浏览器卸载清理。

### 8.2 Console 页面分阶段落地

| 导航组 | 页面 | 首次交付 |
|---|---|---|
| 工作台 | Overview：会话/Case 数、升级、处理时长、Agent 健康/成本 | M1 基础计数，后续指标逐步开放 |
| 支持 | Conversations：消息、引用、工具摘要、人工接管、升级 | M1 |
| 支持 | Cases：列表与三栏详情；Customers：租户/用户关联记录 | M1；Customers 首版可合为筛选视图 |
| 调查 | Investigations、Agent Runs | M2；Run 基础轨迹 M1 已可查看 |
| 解决 | Action Center、Approvals | M3；M2 展示只读 Proposal |
| 知识 | Sources：scope/sync/version/index；Playground：授权检索/引用/缺口 | M1 |
| 接入 | Integrations：能力、健康、READ/WRITE、Policy Coverage | M1 |
| 接入 | Service Catalog、Environments | M2；Project 的环境定义 M1 即存在 |
| 治理 | Agents、Tools & MCP、Policies、Audit Logs | M1 受控配置；M2 增加调查权限视图 |
| 质量 | Evaluations：样本、预期来源/行为、工具、结果 | M2 文件/API 报告，M3 完整页面可选 |

Case Detail 左栏是事件 Timeline；中栏是授权 Context/Evidence，切换 Business、Request、Trace、Logs、Metrics、Deployment、Commit、Code；右栏是 Hypothesis、反证、RCA、Proposal 和 Approval。

每条证据显示来源、事故时版本、采集时间、授权状态和是否截断；未知内容显示未接入/无权限/无证据。Open in Grafana/Sentry 等链接继续使用外部系统权限，不在 URL 中拼 Credential。Console 不做完整日志浏览器。

### 8.3 API-first 与现有客服接入

API 模块对应 Identity、Conversations、Cases、Knowledge、Integrations、Tools、Runs、Proposals、Approvals、Audit、ServiceCatalog。客户 API 和 Operator API 使用不同 DTO/认证策略，不以一个 `includeInternal=true` 参数切换敏感内容。

建议最小 API 语义：创建会话、发消息、创建报告、读取本人 Case、订阅本人进度；Operator 才可启动调查、查看内部证据、提案、审批和审计。异步创建返回资源/Run ID；错误返回标准 problem details；游标分页、幂等键、版本冲突和速率限制行为进入 OpenAPI 契约。

Headless 入站先验证 Webhook 签名（若上游支持）、时间/重放、integration/account 映射，再持久化并快速确认。没有签名机制时通过受认证中继或来源验证补足，不假装所有厂商支持同样签名。按外部消息 ID 去重，记录消息方向，阻止自己回写的回答再次触发 Agent。

人工接管状态是权威门禁：接管后 Agent 可以给坐席建议但不自动发给客户；关闭接管需要明确操作。频道的自动安全回复由管理员预先授权，个别外部写入仍留下投递/审计记录。TicketProvider 与 SupportProvider 分开，避免把对话系统和工程任务系统误当同一种数据模型。

未来 Embeddable Console 使用只读/受限 scope 的嵌入会话和 origin allowlist；不复用管理员登录 Token。私有网络客户在同网自托管或使用受控 outbound Connector，不要求把日志或业务 API 开到公网。

## 9. 推荐 Monorepo

目录是下一阶段的目标结构，当前不会创建空包或占位服务。

```text
apps/
  console/                 # React；构建物可由 server 托管
  server/                  # HTTP、认证、可信 Gateway、组合模块
  worker/                  # 作业消费、有限 Agent 编排；没有目标凭据
  executor/                # M3；审批后外部写入，独立身份
packages/
  web-sdk/                 # 轻量 loader 与 framework-neutral API
  widget/                  # 懒加载 UI；与宿主隔离
  contracts/               # 受控 JSON Schema / OpenAPI / 生成 client
  domain/                  # Case/Evidence/Proposal/状态与不变量
  application/             # Support、Investigation、Approval use cases
  context/                 # correlation 与 provenance
  agent/                   # 角色、Run/Step、预算、结构化输出
  policy/                  # Gateway client、OPA bundle/模板/策略测试
  persistence/             # SQL migration、RLS、repositories、outbox
  provider-contracts/      # Provider 类型、错误、能力合同
  integration-runtime/     # registry、credential binding、egress、redaction
  ui/                      # 确有复用时提取组件
providers/
  knowledge-basic/          # 有界 Markdown/HTML 引用检索
  ragflow/
  openapi/
  mcp/
  loki/
  openobserve/              # M2 Demo 的 Trace/Metric 查询
  kubernetes/               # 只读部署映射，不是 CE 部署前提
  git/
  github/
  openhands/
  langfuse/                 # 可选 exporter
examples/
  invoice-saas/             # 真实可注入故障的小 SaaS
  identity-bridge/          # 服务端 Support Token 示例
  headless-support/         # Webhook/人工接管合同示例
tests/
  security/                 # 越权、注入、SSRF、审批绕过
  provider-contracts/
  acceptance/
  fixtures/                 # 永远标识为 fixture
deploy/
  compose/                  # 基础 + 可选 profile
  helm/                     # M3/之后按需求增加
docs/
  architecture/
  research/
  security/
  integrations/
  planning/
```

依赖方向：apps → application → domain/provider-contracts；providers 实现 contracts，不能反向 import apps。仅 Server/Executor 的组合入口装配真实凭据。一个 Provider 只在根 `/providers` 下存在，不再复制到 `/packages/providers`。

使用 pnpm workspace；开始时不需要 Nx、模块联邦或分布式服务框架。Python 只出现在外部 Coding Provider 或确有必要的隔离 Adapter 中；第三方源码不进入 Core。

## 10. MVP 范围

M1 是可用的 Support MVP；M2 是 Investigation MVP；M3 才完成整个 Patch/Tests/Approval/PR Demo。不能用只读 RCA 演示声称完整“从提问到修复”。

**必须做**：基础 SDK、匿名/识别身份、Conversation、Markdown/Website 引用知识、Case、Provider/Tool/Policy/Audit 框架；一个 tenant-safe OpenAPI；OTel 关联、Loki、Trace 查询后端、部署记录、Git；结构化 RCA；可替换 OpenHands、Sandbox Patch/Test、审批与 GitHub PR。

**可以做**：外部 RAGFlow、Langfuse 导出、Chatwoot 真实接入、简单服务自动发现、Eval Console。

**以后做**：Confluence/Notion/Drive 等连接器、完整 GraphQL、跨 Case Incident、Living Documentation 检测、更多 Coding Provider、企业目录同步、复杂保留策略、Helm HA。

**现在不做**：生产自动重启/回滚/SQL，自动合并/发布，全量遥测仓库，通用自主浏览器/SSH Agent，OCR/Embedding Pipeline，完整 CMDB，客户 Connector Marketplace 的任意代码加载。

完整范围、每段必做/可做/不做与正反向验收见[实施计划](../planning/mvp-roadmap.md)。

## 11. 分阶段实施计划

| 阶段 | 目标 | 进入下一阶段的条件 |
|---|---|---|
| M0：设计落地与风险验证 | 架构确认后建骨架；契约、RLS、Policy、Provider conformance；最小 Spike | 两租户越权被拒；外部系统无法绕过策略；关键 API 版本合同可执行 |
| M1：Support 可用 | SDK → 身份 → 知识回答/报告 → Case；可恢复 Run 与审计 | 未接 Runtime/Coding 仍能使用；引用可核对；匿名/登录/人工接管隔离 |
| M2：调查与 RCA | 业务 → Trace/Logs → 部署/Commit/Source → 结构化 RCA | 每个根因声明能定位证据；缺失/反证/限权路径可见；重启可恢复 |
| M3：修复提案与 PR | Sandbox、Patch、前后测试、绑定内容的审批、Executor 发布 PR | 拒绝/过期/变更审批不执行；批准只生成一个可核对 PR；生产未被改动 |

实施顺序优先解除高风险未知：身份与 tenant enforcement → Provider 作用域能力 → 事故版本关联 → Sandbox 工具是否能全部受控 → 测试证据与 PR 审批。之后再扩展页面和连接器数量。

每阶段通过明确出口验收后再推进；不在当前架构稿中承诺缺乏人员/环境前提的日历工期。客户接入时长也不等于平台开发工期。

## 12. 当前风险、遗漏与决策记录

| 风险/原需求未充分定义处 | 本稿处理 | 仍需验证/决定 |
|---|---|---|
| 平台租户与 SaaS 客户租户混淆 | Organization → Project → Tenant；独立 Operator | 客户多产品/多身份源映射样例 |
| OTel 没有通用历史查询 API | 明确 Trace backend；Demo 选 OpenObserve | 各 backend 的时间/租户过滤与版本合同 |
| 共享 Runtime 数据难按客户过滤 | 先可信关联，字段裁剪；无归属证据不向客户开放 | Loki 的组织 ID 是否只是运营方 ID，不能误当业务 tenant |
| 浏览器能伪造 trace/entity/page | 只作线索，服务端验证归属 | 老 SaaS 需要的最小后端改造量 |
| 当前部署不等于事故时部署 | 保存 image digest、发布历史、commit provenance | CI 是否已有可信 release manifest |
| 15 分钟与重组件冲突 | 基础轻检索、已有 Provider 即可；重组件可选 | 干净机器与真实 SaaS 的接入实测 |
| 权限可能绕过 Core 到 Coding Agent | 每个可执行工具受 Gateway/隔离 Runtime 控制 | OpenHands Custom Tool/授权扩展能否完整覆盖；不行则保持禁用 |
| 审批后改参数、Token 过期、目标变动 | 内容摘要、版本、再授权、前置条件、reconcile | GitHub 合同与超时恢复测试 |
| 任意 OpenAPI/MCP/URL 是攻击入口 | 候选审核、Schema 隔离、egress 和凭据受众限制 | 导入器 fuzz/SSRF/description injection 测试 |
| 索引撤权比源文档慢 | ACL revision、TTL、撤销事件、返回时再授权 | Provider 无强制 prefilter 时隔离 dataset 或禁用 |
| 自动 RCA 过度确信 | 支持/反对证据、unknown、验证状态、人工反馈 | 带对照组的标注数据集与校准 |
| 自动答复与人工坐席同时发送 | Conversation takeover 状态和外发门禁 | 客服系统重复/乱序/回写回环测试 |
| 长任务失败、费用失控 | checkpoint、预算、公平并发、取消与幂等 | pg-boss 与 Outbox 压测、任务恢复 |
| Self-host 不代表数据不外发 | ModelProvider 地域和分类策略、可禁公网 | 具体模型条款/数据处理合同 |
| 脱敏不能保证识别所有秘密 | 先字段白名单与上游治理，无法投影则拒绝 | 各客户领域敏感字段、附件处理策略 |
| 核心审计与第三方 Trace 混淆 | Core 不采样 Audit；Langfuse 可选 | 外部防篡改/保留与删除要求 |
| 开源版基础安全被第三方 EE 功能限制 | Core 自己负责 ACL、审批、审计，不依赖 EE 门禁 | 锁版本逐件检查 CE/EE 能力边界 |
| 许可证/商标/分发方式 | Core Apache-2.0、SDK MIT；本地已添加许可文件 | 最终品牌与发布许可；第三方镜像/SBOM/NOTICE 审核 |
| 备份和升级也是可用性要求 | M1 备份/恢复验证，migration 有升级路径 | Artifact/DB 一致恢复，生产 RPO/RTO |

推荐接受的初始架构决策：模块化单体；TypeScript Core；PostgreSQL + pg-boss，Redis 后置；OPA 默认；Case 为调查/授权/审计中心；Provider 优先，MCP 作为受控工具协议；公共支持可以独立启用；工程写操作隔离执行；完整 MVP 终点为审批后的 PR，不包括生产发布。

2026-09-14 用户授权开始开发并确定名称 agent18；Core 已采用 Apache-2.0、SDK 采用 MIT。M0 基础链路已落地，外部 Provider Spike 尚待完成；未发布软件、镜像或远程仓库。实际交付状态见 [M0 实施记录](../development/m0-foundation.md)。
