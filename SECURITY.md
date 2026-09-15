# Security policy

agent18 0.7.0 是集成预览，目前没有承诺长期支持的生产稳定版。仓库提供明确的身份和执行边界、自托管部署指引以及可运行的隔离/恢复验证。

## Reporting

若 [GitHub Security](https://github.com/LoganLiu92/agent18/security) 提供私密漏洞报告入口，请使用它；否则先通过维护者已有的私密渠道约定报告方式。项目没有声明独立安全邮箱或保证私密报告功能已启用。不要在公开 Issue 上传密钥、客户记录或可直接利用的漏洞细节。

## Implemented boundaries

- 客户 Token 固定 EdDSA、静态公钥、issuer/audience、项目绑定和最长 10 分钟寿命；客户角色不能获得本地 owner 权限。
- PostgreSQL FORCE RLS 隔离项目/租户/用户，知识按允许受众共享；运行账户不拥有表，也无 BYPASSRLS。
- 知识来源默认内部；工作台/CLI 才能配置、构建、导出和发布。watch 只生成草稿；受众收紧或撤下影响历史证据可见性。
- 仓库只读扫描，不执行代码；过滤链接、产物、凭据与疑似密钥。过滤和引用校验不保证全部机密识别或模型语义正确。
- OpenAPI 仅导入受限 GET 候选，默认关闭；固定服务端地址、角色和返回字段，禁止重定向并限制时间和响应大小。SaaS 再校验当前身份与对象授权。
- 业务写入来自明确注册表，经过预览、用户确认、配置/角色/期限复核、OPA 和持久审计；SaaS 负责幂等、当前权限、数据版本与事务化回执。结果不确定时只核对回执。
- 客户消息不能伪造支持作者，Core 不开放本地收件箱；本地 owner 从项目绑定的持久化记录派生回复范围。
- Provider/Tool 元数据只有 Owner 能导入和审核；未审核、撤销或定义漂移默认拒绝，Run 固定注册指纹。运行期间和历史证据读取均检查来源状态。
- 显式页面环境、traceId 和实体字段是客户提供的线索，不是身份或授权依据；高风险工具等待可信审批，本版没有客户自助签发审批的入口。
- Worker 使用独立 workload 凭据和短期租约，只消费后台只读运行，不调度业务写入。
- Audit、Evidence、RunStep 和 CaseMessage 对应用只允许追加/读取；数据库管理员仍可管理数据库，不宣称密码学防篡改。
- 本地工作台绑定回环地址，验证 Host、Origin、客户端地址与独立访问码；公开部署不代理它。演示签发器单独使用 demo profile。
- 备份包含秘密配置，以受限权限保存；恢复创建新库并验证隔离，显式激活不会覆盖原库。备份文件只应来自可信部署者。

- 页面报告有界采集并在提交前预览，表单、Cookie、存储和网络正文不采集；截图默认关闭，敏感区域需宿主标记。启发式清洗不保证识别所有机密。
- HTTP/Loki/Prometheus 地址、查询和凭据仅 Owner 配置；排查工具仅内部 Operator 可调用。工单日志追加可信租户/可选用户标签，工程证据不向客户返回。上游标签/代理权限仍由接入方保障。
- 巡检使用持久租约和配置指纹；空数据或连接失败为未知，健康观测才能恢复异常。模型辅助默认关闭，开启后仅接收有界脱敏摘要与页面错误，不接收截图。

## Deployment responsibilities and remaining work

真实 SaaS 接入与用户对象权限需要现场验证；短期 Token 不提供即时撤销。仍需按环境配置远程 JWKS/SSO、企业管理 RBAC、高风险操作二次认证、全局配额、密钥托管、审计保留和导出、漏洞扫描、HA 与外部服务监控。

当前没有任意 Shell/SQL、网页点击代理、自动部署/代码修复、通用文件解析/OCR、多步业务事务或无人审核的自动知识发布。内置诊断与本地恢复演练不能替代真实业务验收和离机灾备。

合同：[技术标准](docs/reference/standards.md)、[身份](docs/guides/integration.md)、[知识](docs/guides/knowledge.md)、[业务查询](docs/guides/business-queries.md)、[业务写入](docs/guides/business-actions.md)、[运维](docs/guides/operations.md)。
