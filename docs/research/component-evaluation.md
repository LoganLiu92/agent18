# 开源组件评估与版本证据

> 历史版本/选型记录。当前能力与真实监控接入见 [0.7 运行综述](../overview/agent18-0.7-operations.md)。

核验日期：**2026-09-14**。结论用于架构选型，尚未执行组件部署、性能基准、租户隔离联调或正式许可证合规审查。

方法：实时查询官方 GitHub `releases/latest`，排除 prerelease；读取对应版本的 LICENSE 并保存 SHA-256。API/SDK 能力查询官方文档和仓库；滚动文档可能领先稳定版本，因此进入 M0 后仍须对锁定版本做合同测试。原始事实见 [component-snapshot.json](component-snapshot.json)。部署复杂度是根据依赖和信任边界作出的工程判断，不是实测资源消耗。

“维护活跃”只表示近期有正式发布和可访问的维护资料，不代表响应 SLA、漏洞已清零或企业可用性保证。未使用 Star 数替代维护评估。

## 1. 版本、维护与许可证快照

| 项目 | 本次最新正式发布 / 日期（UTC） | 许可证观察 | 采用决定 |
|---|---|---|---|
| RAGFlow | [v0.27.2 / 09-10](https://github.com/infiniflow/ragflow/releases/tag/v0.27.2) | [Apache-2.0](https://github.com/infiniflow/ragflow/blob/v0.27.2/LICENSE) | 外部 KnowledgeProvider；不强绑 Core |
| OpenHands 产品 | [v1.18.0 / 09-11](https://github.com/OpenHands/OpenHands/releases/tag/v1.18.0) | 根目录 [MIT](https://github.com/OpenHands/OpenHands/blob/v1.18.0/LICENSE) | 不 Fork 产品前后台 |
| OpenHands Software Agent SDK | [v1.47.0 / 09-10](https://github.com/OpenHands/software-agent-sdk/releases/tag/v1.47.0) | [MIT](https://github.com/OpenHands/software-agent-sdk/blob/v1.47.0/LICENSE) | M3 CodingAgentProvider 首选 |
| Langfuse Server | [v4.35.0 / 09-11](https://github.com/langfuse/langfuse/releases/tag/v4.35.0) | [非 EE 范围 MIT，指定 EE 目录另有条款](https://github.com/langfuse/langfuse/blob/v4.35.0/LICENSE) | 可选外部观测/评测；Core 审计独立 |
| OTel Collector Core | [v0.160.0 / 09-02](https://github.com/open-telemetry/opentelemetry-collector/releases/tag/v0.160.0) | [Apache-2.0](https://github.com/open-telemetry/opentelemetry-collector/blob/v0.160.0/LICENSE) | 采用标准；按需配置 Collector |
| OpenObserve | [v1.0.0 / 09-11](https://github.com/openobserve/openobserve/releases/tag/v1.0.0) | [OSS 为 AGPL-3.0](https://github.com/openobserve/openobserve/blob/v1.0.0/LICENSE)，EE 为单独商业条款 | 外部 Provider；Demo 的 Trace/Metric 后端 |
| Loki | [v3.7.7 / 08-27](https://github.com/grafana/loki/releases/tag/v3.7.7) | [AGPL-3.0](https://github.com/grafana/loki/blob/v3.7.7/LICENSE) | 外部 Log Provider |
| Sentry Server | [26.8.0 / 08-15](https://github.com/getsentry/sentry/releases/tag/26.8.0) | [FSL-1.1-Apache-2.0](https://github.com/getsentry/sentry/blob/26.8.0/LICENSE.md) | 只接现有服务 API；不内嵌服务端 |
| OPA | [v1.20.2 / 09-03](https://github.com/open-policy-agent/opa/releases/tag/v1.20.2) | [Apache-2.0](https://github.com/open-policy-agent/opa/blob/v1.20.2/LICENSE) | 默认 Policy Engine |
| Cedar | [v4.12.0 / 07-28](https://github.com/cedar-policy/cedar/releases/tag/v4.12.0) | [Apache-2.0](https://github.com/cedar-policy/cedar/blob/v4.12.0/LICENSE) | 可替换候选，不与 OPA 同期双实现 |
| Chatwoot | [v4.17.1 / 08-27](https://github.com/chatwoot/chatwoot/releases/tag/v4.17.1) | [非 enterprise 范围 MIT，enterprise 单独条款](https://github.com/chatwoot/chatwoot/blob/v4.17.1/LICENSE) | Headless Support 集成参考 |
| MCP | [规范 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning)；TS client 2.0.0；[Python v2.2.0 / 09-07](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.2.0) | TS 项目存在 MIT → Apache-2.0 过渡；Python 所核版本 [MIT](https://github.com/modelcontextprotocol/python-sdk/blob/v2.2.0/LICENSE) | 使用官方 SDK；按包与协议核验 |

所有项目在本次快照的最近约两个月内都有正式发布。OpenObserve 刚到 1.0、MCP 有协议迁移、Langfuse 有服务端/SDK 多代版本，这些都要求锁版本和兼容性测试，不能直接把 `latest` 写进交付 Compose。

**MCP 许可证的具体不一致：**本次 npm `@modelcontextprotocol/client@2.0.0` 的 metadata 写 MIT，但对应仓库 tag 的 LICENSE 明确说明 MIT 向 Apache-2.0 的贡献迁移规则，文档另有 CC-BY-4.0 范围。不能用 npm 一个字段覆盖仓库实际条款。M0 锁定具体分发包，核验包内 LICENSE/NOTICE 并保留两类必要声明。[对应 tag LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol%2Fclient%402.0.0/LICENSE) · [npm metadata](https://registry.npmjs.org/@modelcontextprotocol/client/2.0.0)

## 2. RAGFlow

功能/API：提供 Dataset、文档导入/解析、检索与引用能力；HTTP retrieval 适合把片段交给 Core 统一授权和回答。官方另有 Python API。Core 首选 `POST /api/v1/retrieval`，只访问后端决定的 dataset/document 集合，同时检查 HTTP 状态和业务返回码，不把 RAGFlow 的聊天/Agent 平台作为 Core 控制面。[HTTP API](https://ragflow.io/docs/http_api_reference) · [Python API](https://ragflow.io/docs/python_api_reference)

部署：较高。所核版本 Compose 包含元数据、对象存储、缓存与可选检索引擎等依赖，部分服务是替代选项/profile，不能理解成全部必装。它适合独立升级的知识服务，不适合成为任何 SDK 客户都必须先启动的后台依赖。[版本化 Compose](https://github.com/infiniflow/ragflow/blob/v0.27.2/docker/docker-compose-base.yml)

决定：推荐复杂文档/PDF 的首个 KnowledgeProvider；不重复做 OCR、Embedding Pipeline、表格解析或向量引擎。轻量 Markdown/Website 模式只提供有界文本引用检索，复杂检索交外部 Provider。

M0/M1 验证：按租户/ACL 预过滤是否可靠；授权撤销后是否仍命中缓存；引用能否绑定文档版本；滚动文档中的参数是否存在于固定版本。不支持强过滤时隔离 Dataset/凭据或禁用该场景，不能先检索全库再隐藏答案。

## 3. OpenHands

产品与 SDK 是两个独立版本系列。Software Agent SDK 提供 Python/REST API、Agent Server、自定义工具、结构化输出、持久化与远程 Workspace，适合封装为 CodingAgentProvider。Core 不需要复用 OpenHands 的聊天 UI。[SDK 官方说明](https://docs.openhands.dev/sdk)

部署：本地试验中等，隔离可靠的多租户部署较高；Agent Server、临时执行环境、资源限制、网络策略与清理都要独立设计。SDK 的工具或确认机制不替代 agent18 的授权和审批。不能照搬方便开发的主机目录或 Docker socket 挂载进入受攻击代码环境。

决定：M3 先做 start/status/cancel/artifacts 和可控 Tool 接口。SDK 只得到当前 Case 的必要源码、证据与模型访问代理；GitHub 发布凭据在独立 Executor。Sandbox 产生 Diff，不自行发布 PR。

准入测试：所有 Bash/edit/network 工具能否被受控工具层覆盖；默认工具不可绕过 Gateway；恶意 README/测试/依赖脚本不能获取 Core 或云 metadata 凭据；Patch 不能偷偷修改工作流、增加 Secret 或更换 base SHA。无法满足则停在只读源码/方案阶段。

## 4. Langfuse

功能/API/SDK：Agent Trace、模型调用/费用、Prompt 管理和 Evaluation；当前官方 SDK 文档为 Python v4、JS/TS v5，并区分与服务端 v4 API 的兼容关系。提供 SDK、OTel 导出与 public API；不把服务端版本号当作 SDK 版本号。[SDK 与兼容性](https://langfuse.com/docs/observability/sdk/overview)

部署：较高。官方自托管架构包含 Web/Worker、PostgreSQL、Redis、ClickHouse 和 Blob/S3 存储。数据采集和检索路径有各自运维成本。[自托管架构](https://langfuse.com/self-hosting)

决定：可选 exporter 和评测集成。Core 保存业务级 AgentRun/Step、Evidence 和不可遗漏的 Policy Audit；Langfuse 可以接收清洗后的观测副本。关闭/故障时不阻断基础客服，但不能静默丢失 Core 审计。

准入测试：tenant/Case 标签与 Console 深链不会跨租户；不得把 Token/原始工具响应随 Trace 导出；所需功能确属可用版本/许可范围。只看根目录 MIT 而忽略 EE 子目录不够。

## 5. OpenTelemetry

功能/接口：多语言 instrumentation、Collector、OTLP、Trace/Log/Metric 信号；采用 W3C Trace Context 关联请求。Collector 可作 Agent 或 Gateway 部署。各语言 SDK、Collector core/contrib 和信号成熟度不同，没有一个“OTel 全家桶版本”。[Collector 部署](https://opentelemetry.io/docs/collector/deploy/) · [成熟度](https://opentelemetry.io/status/)

部署：只接现有信号的成本较低；新增采集、采样、导出和资源标签治理则中等以上。Core 不接收/存储整个生产遥测流；只保存与 Case 相关的过滤结果和出处。

决定：采用标准与客户既有 Collector。`providers/otel` 若未来出现，只能表示 instrumentation/关联辅助，不能伪装成不存在的通用 OTel 历史查询接口。查询职责在 ObservabilityProvider 的具体后端。

准入测试：可信 tenant → request → trace 绑定；消息队列传播/Span Link；采样缺失；时钟偏移；deployment/environment/service.name 映射；不要把所有客户 ID 放入高基数 Metrics label。

## 6. OpenObserve

功能/API：Logs、Metrics、Traces；官方 Search API 通过 `POST /api/{organization}/_search` 接受有时间约束的查询。调用可用普通 HTTP 客户端，不为接入而引入新的专用 SDK；平台中的 organization 不一定等于 SaaS 的客户 tenant。[Search API](https://openobserve.ai/docs/reference/api/search/search/) · [API 目录](https://openobserve.ai/docs/reference/api/)

部署：单节点较低，可使用本地磁盘；HA 会增加 NATS、PostgreSQL、对象存储与多个角色。单节点简单不能推导出生产 HA 也简单。[架构与部署模式](https://openobserve.ai/docs/architecture/)

决定：支持客户已有实例；M2 Demo 复用它补齐 Trace/Metric 后端，只实现 Demo 需要的受限查询。现有 Loki 客户继续用 Loki，不要求改存储。

风险：AGPL OSS 与商业 EE 范围不同；查询必须带 scope/time/field/size 的后端约束，禁止把自由 SQL 交模型任意生成后执行；Trace 表字段映射与错误处理在固定版本上测试。保留第三方许可证，不复制服务端实现到 Core。

## 7. Loki

功能/API：LogQL 日志查询，`query_range`/`query`；适合 Case 相关时间窗口和特定 trace/request/service 查询。使用官方 HTTP API 即可，不依赖非必要的社区 SDK。[Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)

部署：接现有实例较低；自建单节点中等；分布式/长期存储复杂度更高。agent18 不搭建 Grafana UI，也不做 Loki 数据搬迁。

关键安全事实：Loki 本身不提供认证层；multi-tenant 模式的 `X-Scope-OrgID` 应由可信认证代理注入。该值不能来自 LLM 或浏览器，也不能假定它与业务 tenant 一致。[Loki 认证文档](https://grafana.com/docs/loki/latest/operations/authentication/)

决定：M2 首个 Logs Adapter。允许结构化过滤而不是任意 LogQL；强制租户证据、service allowlist、时间上限、行数/字节限额、脱敏与来源链接。缺少可信客户归属的共享日志只能进入另外授权的内部调查域，绝不能进入 Customer Agent。

## 8. Sentry Integration

功能/API：官方 API 提供事件/Issue 等程序访问，当前 Web API 版本为 v0；SDK 主要用于 instrumentation，Core 查询不要求客户重新安装所有 SDK。按 endpoint 所需最小权限核验，不能假设所有读取端点统一使用某个 scope。[Sentry API](https://docs.sentry.io/api/)

部署：接客户现有实例较低；完整自托管属于另一套较复杂系统，无需作为本项目部署前提。

许可证：所核服务端为 FSL-1.1-Apache-2.0，带用途条件和未来许可转变；当前受限代码不能笼统描述成宽松开源软件。不同 SDK、文档、服务端和托管 API 条款必须分别看。[该版本服务端 LICENSE](https://github.com/getsentry/sentry/blob/26.8.0/LICENSE.md)

决定：只读 Provider、外部 deep link，后续接入；不要以“采用了 API”就宣称所有再分发或竞争用途限制自动消失。首版已经有 Logs/Traces，Sentry 不阻塞完整 Demo。

## 9. OPA 与 Cedar

OPA 提供 Rego、HTTP Data API、Policy Bundle 与测试；Cedar 提供基于 principal/action/resource/context 的授权、Schema validator、Rust crate、CLI 与 WASM 接口。两者都可以从 LLM 之外执行授权。[OPA REST API](https://www.openpolicyagent.org/docs/rest-api) · [Cedar 官方仓库](https://github.com/cedar-policy/cedar)

| 比较项 | OPA | Cedar |
|---|---|---|
| Core 接入 | 独立服务 HTTP/JSON，适合 TS Core | Rust/WASM，或另配适配运行时 |
| Tool/环境/字段/Scope 规则 | Rego 可表达结构化约束，必须控制复杂度 | 授权语义与 Schema 检查清楚，结果映射需 Adapter |
| 运维 | 小型服务、bundle 生命周期、健康/决定日志 | 嵌入可少一进程，但需要绑定与策略分发方案 |
| 审批 | 由 Core 接收决定并管理 Approval 状态机 | 同样不替代 Approval 工作流 |
| 首版决定 | **采用**，默认 deny | 保留接口，不双实现两套可漂移政策 |

M0 必测：default deny、显式 DENY、未定义决定、OPA 宕机、越权 Scope、L5 禁止、审批过期、双人审批、policy revision 切换、schema/结果不兼容。OPA 管理接口不在 Agent 可访问网络域中。

## 10. Chatwoot

功能/API：官方区分 Application、Client、Platform API；适合做既有客服系统与 agent18 Headless 的接入参考。使用会话/消息 API、Webhook 和人工接管，不 Fork 一个客服台进 Core。[API 说明](https://developers.chatwoot.com/api-reference/introduction)

部署：接现有实例较低；自托管中等，Rails/Worker、PostgreSQL、Redis 和附件/邮件配置仍需运维。官方有 Docker/升级路径，不代表平台用户需要同时安装它。[Docker 部署](https://developers.chatwoot.com/self-hosted/deployment/docker)

决定：M1 先建立入站/回写/接管合同测试；真实 Chatwoot Connector 可在 M3 加入，不阻塞 Native Demo。非 enterprise 内容 MIT，enterprise 目录单独许可；不把 Chatwoot EE 的企业治理能力当作 Core 已具备。

准入测试：account/inbox/contact 映射、重复乱序事件、私有消息可见性、自己的回复回环、人工接管后停止自动回复、外部用户伪造 tenant；发送失败不能重复发给客户。

## 11. MCP 生态

当前规范是 **2026-07-28**，其无状态请求模型、逐请求版本、`server/discover`、扩展机制与早期会话式协议不同。首版采用官方 SDK，兼容旧协议通过 Adapter 实现，业务域不依赖某种 MCP session 状态。[版本规则](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning) · [正式发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

TypeScript 仓库已按包发布，`releases/latest` 返回 fastify 子包 tag，并不能代表 Client 的最新版本；本次另查 npm 得到 client 2.0.0。Python SDK 本次稳定版 2.2.0。协议版本、SDK 主版本和某个第三方 MCP Server 支持版本需要分别记录。

当前 TS SDK 的 issuer 校验、凭据隔离等要求有 opt-in 配置；不能只升级 npm 依赖就称满足新规范。[官方迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

部署：远程 HTTP Client 本身较轻，真正成本在每个 Server 的权限、网络、身份委托与稳定性。工具目录只是发现；描述/annotations 不能授予权限。远程 Tool Response、Resource、Prompt 一样视为不可信数据。[MCP 规范安全原则](https://modelcontextprotocol.io/specification/2026-07-28)

决定：优先 API/官方 SDK；已有 MCP 服务时通过 MCP Adapter 接。登记 Server、固定版本/Schema、禁止隐式安装、限制结果/时间/网络、隔离令牌受众。OTLP 继续负责遥测传输，MCP 不运输整个生产日志库。

## 12. 采用前的具体门槛

1. 锁定版本、镜像 digest、SDK、协议、API path；LICENSE/NOTICE/SBOM 与实际发布包对应。
2. 用两个客户租户验证 prefilter、字段投影、撤权、缓存与分页隔离。
3. 验证 Provider 不支持/超时/限流/部分成功时的语义，不能变成“无异常”。
4. 用受限 Credential 联调，不因端点失败扩大到管理员凭据。
5. 在可独立升级的 Adapter 上跑 conformance tests；Core 不 import 第三方内部 DB schema。
6. 评估部署、导出/删除、备份与安全补丁路径；许可不明确的功能保持外部且禁用，直到具体分发/使用方式得到确认。

AGPL、FSL 和商业 EE 不应一概混称为“不适合商用”；本稿只确定技术隔离与引用范围。外部 API 集成可以减少代码耦合，但不会自动免除具体许可、服务条款或再分发义务。当前未分发任何第三方二进制或源码。
