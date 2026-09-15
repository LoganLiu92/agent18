# agent18 0.6：核心抽象审查与实现

0.6 是 Core Foundation 预览版。它将现有知识与业务支持链路升级为可注册、可审核、可追溯的能力运行基础，保留 L1–L3 的实际行为。它没有交付生产日志连接器、自动根因分析、编码代理或 PR 创建。

## 审查结论与本轮落点

| 0.5 限制 | 0.6 实现 | 验证方式 |
| --- | --- | --- |
| Context 只认 invoice/order/other | 命名空间、实体类型与 ID，显式 trace/session/version/correlation 标签 | SDK 白名单、大小限制、未知字段和 URL 秘密排除测试 |
| Case 的 Evidence 就是 Citation | 独立 Evidence envelope；知识引用作为可选的 citation 子类型 | 非知识日志证据实际持久化、来源/范围/受众批次校验、旧引用迁移 |
| Run 直接调用 knowledge.search | 服务端工作流选择已注册只读工具；通用输入校验、调用和结果发布 | 同一个 CaseService/RunService 执行合成 logs.search |
| RunStep 固定两种名称 | capability/tool/provider、输入输出引用、耗时、策略结果与单调事件顺序 | 运行、取消、重试、超时和隔离回归 |
| OPA 按几个固定 ID 授权 | Principal / Action / Resource / Context；ALLOW、DENY、APPROVAL_REQUIRED | 通用工具 ID、环境、风险、受众、资源与确认的允许/拒绝测试 |
| Provider 只有 interface | 内存绑定注册中心 + 数据库审核注册中心 + Owner CLI | 未审核/撤销/定义漂移不调用；App 无审核权限 |
| MCP 与能力领域并列 | ToolTransport 区分 native/http/openapi/mcp；领域独立 | 同一工具 binding 使用独立 transport 元数据；尚无在线 MCP 会话实现 |

## 实际运行机制

宿主 SaaS 的会话先换取短期客户身份。用户通过一个对话框提问、查询或提交问题；前端仅发送显式上下文。服务端从签名身份建立 scope，前端提供的 `environment`、`entity`、`traceId` 均是待核实的排查线索，不能选择授权环境、工具或身份。

CaseService 根据服务端工作流选择工具，将经过该工具输入 schema 校验的参数、工具版本、Provider 与注册定义指纹写入 Run。Case、Run、outbox 和审计同一事务提交。默认工作流仍是知识检索；新增工作流由部署者的服务端代码注册，客户请求不能传入 Run 计划。

Worker 只接收调度 ID，取得限时租约后请求 Core 执行。Core 保留 advisory lock、预算、取消、次数和 scope revision 检查；通过 ToolRegistry 校验审核状态、实现绑定、Provider 版本、transport 与输入输出 schema，再交给 OPA 授权。工具审核撤销、定义改变或 Run 指纹不匹配会阻止执行。通用运行器只接受 READ/READ 工具，因此队列重试不会派发业务写操作。

Provider 返回类型化 Evidence。Core 校验整批 schema、组织/项目/租户/用户、工具 provenance、资源类型、受众和敏感度；结束调用后再次检查注册状态。只有全部通过且 Run 尚未取消，步骤、证据和结束结果才在事务中发布。

客户查看 Case 时，还会重新检查 Provider/Tool 状态和来源可见性。未知、撤销、内部或受限证据不可见。客户响应不包含 scope 和 artifactRef；artifactRef 只是为以后独立授权的产物存储预留，并没有公开下载接口。

## Evidence 合同

Evidence 包含 id、kind、source、observedAt、resource、summary、artifactRef、visibility、sensitivity、scope 和 provenance。kind 支持 knowledge、business、log、trace、metric、error、deployment、commit、code；这描述可表达的数据类型，不代表这些连接器已经实现。

知识证据额外包含原有安全 Citation：标题、摘要、来源版本和观测时间。知识搜索/问答接口仍返回原有 `citations`，保持 SDK 检索行为；`CaseDetail.evidence` 在 0.6 改为 Evidence 数组。浮窗、内嵌与独立页都已使用该结构显示。接入者自建 Case UI 需要从 `e.summary` 取摘要、从 `e.citation?.title` 或 `e.resource.type` 取展示标题。

Provider 必须返回与调用者相同的范围；资源过滤应在适配器及上游系统再执行。范围标签校验不能证明上游真的执行了租户隔离，也不能自动完成秘密识别。只有经审核的适配器可以成为可信数据来源，不能把任意 MCP Server 的自述当作证明。

## Policy 合同

Action 是已审核的 Tool 描述，包括 capability、version、provider、effect、risk、stage、audience、resourceTypes、environmentPolicy。Resource 带可信 scope、类型和可见性。Context 带身份期限、授权能力有效性、服务端环境、运行阶段、Case 与明确确认信息。

低/中风险的客户读操作必须同时满足当前范围、已审核注册、资源类型、环境和受众。业务写操作还必须是 EXECUTE、来自交互支持链路并具有明确确认。高风险能力返回 APPROVAL_REQUIRED，直到存在可信审批校验；本版本没有高风险审批签发服务，客户也不能提交 approvalId 将自己升级为已批准。APPROVAL_REQUIRED 不执行工具，也不会被当作 ALLOW 重试。

业务 prepare、execute 与 query 现在从同一审核注册表获取工具定义；具体动作的启用、角色、参数、固定地址、配置 hash、对象归属和 SaaS 回执校验保持原有路径。核心 ToolRegistry 授权不能替代这些业务校验。

## 注册与扩展

参见 [Provider 与 Tool 注册规范](../reference/providers.md)。Owner 导入 manifest 只创建 pending 元数据；查看定义指纹并审核后才进入 approved。运行账户没有注册或审核写权限。安装原生 Provider 的代码仍需要部署者构建并注入 ProviderRegistry，导入 JSON 不会下载、安装或执行代码。

工具 binding 带独立的输入和输出 Zod schema；对应 JSON Schema 参与审核和定义指纹。MCP、OpenAPI 或 HTTP 是 transport，不是新的权限类型。未来的 MCP discovery 只能产生待审核候选，不能绕过本地 binding、注册和策略网关。

## 从 0.5 升级

1. 停止接受新请求并执行 `pnpm backup`，保留备份目录中的配置、数据库和 manifest。
2. 更新源代码，执行 `pnpm install --frozen-lockfile` 和 `pnpm demo:start`（公开部署使用 `pnpm deploy:start`）。Compose 运行一次性迁移并启动新 Core；0.6 的策略版本标签会让 OPA 重新加载新版规则。
3. 验证 `pnpm run doctor`、旧 Case/引用、客户身份、业务预览与一次确认，再恢复访问。Core、SDK 与 OPA 应一起升级，不能混用 0.5 的策略结果协议。

006 迁移保留旧 citation 列并将历史引用转换为完整 Evidence，回填通用步骤与序号；不会把已撤销的知识工具重新批准。007 为历史知识 Run 补充注册指纹；008 将缺少实际授权结果的旧失败步骤标为未知，避免将工具故障误称为策略拒绝。迁移仅由一次性管理员账户执行，App 与 Worker 的 RLS 和只追加权限不变。

数据库降级不提供反向 DDL。需要回退时，将升级前备份恢复到隔离新库，使用对应旧版代码验证并显式激活；不要用旧 Core 直接连接升级后的 schema。

## 范围与下一阶段

默认每个 Run 执行一个受限只读能力。0.6 没有自动多步骤计划、Hypothesis/Findings 根因模型、通用工程审批服务或产物存储。测试中的 logs.search 是合成适配器，证明架构可扩展，不是 Loki/OTel 的生产验收。

后续按独立可验收链路推进：0.7 选择一个真实日志/Trace 连接器和一个外部知识 Provider；0.8 将服务、部署、仓库与 commit 关联；0.9 生成可审核的工程建议；最后在隔离沙箱内接入编码、测试和 PR。可发布 SDK 与官方镜像属于正式交付能力，目前仍通过源码和自托管 SDK 文件使用，尚未发布 npm 包或官方公共镜像。
