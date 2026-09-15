# Security policy

agent18 0.3.0 是开发预览，没有受支持的生产稳定版。默认 Compose 只发布回环端口；固定演示身份签发器不可公开部署。

## Reporting

仓库为 [LoganLiu92/agent18](https://github.com/LoganLiu92/agent18)。若仓库 Security 页面提供私密报告入口，请使用它；否则先通过维护者已有私密渠道约定报告方式。项目尚未声明独立安全邮箱或保证私密报告功能已启用。不要在公开 Issue 上传密钥、客户记录或可直接利用的漏洞细节。

## Implemented boundaries

- 客户 Token 固定 EdDSA、静态公钥、issuer/audience、项目绑定，最长 10 分钟；角色来自已验证的 SaaS claim，admin 仍为客户身份。
- PostgreSQL FORCE RLS 隔离组织/项目/租户/用户；知识是组织/项目/允许租户下共享资料。运行角色不拥有表，也没有 BYPASSRLS。
- 知识源默认内部，部署者 CLI 才能导入/导出/发布。客户只读当前活动版本；失败构建不覆盖已发布版本。索引角色不能读取 Case，Core 不能修改知识来源。
- 目录扫描不执行代码，跳过符号/硬链接、常见敏感/产物目录及匹配密钥的文件；Git 固定 commit、禁用 hook、不 checkout。过滤不能识别全部机密，发布前必须审核来源范围与生成文章。
- BYOK 模型只生成结构化文本，无执行工具；请求/响应大小、时间、并发有界。模型内容必须引用可见资料；引用合法不代表语义必然正确。密钥不进入浏览器、Worker 或原始日志。
- 业务操作必须来自部署注册表，沿用用户身份，SaaS 预览、用户确认、期限/角色/配置复核、OPA 与持久审计之后才发出写请求。业务桥承担对象授权、业务校验、事务化幂等回执；超时保持不确定，核对不重发。
- 只读 Run 执行、取消和有限重试不用于业务写操作。Worker 只收到 dispatch ID，并需 Core 提供短期 lease；不能访问 Case/知识表。
- Evidence、RunStep 和 Audit 对 Core 只允许追加/读取；数据库管理员仍能改数据，本项目不宣称防篡改存储。
- `.local` 忽略于 Git/Docker 构建；容器按用途挂载单个配置。SaaS demo 单独持有私钥与业务数据，Core 持有模型配置与公钥，Worker 只有队列与 workload 凭据。

## Production gaps

仍需真实 SaaS 身份/业务适配和验收、远程 JWKS/即时撤权、Operator 控制台与审批、高风险业务二次认证、全局配额/费用控制、独立密钥管理、审计保留/导出、SBOM 与漏洞扫描、备份恢复演练及监控。当前无任意 Shell/SQL、运行时日志调查、自动部署/代码修复、多步业务事务、OCR/文件上传或内置知识同步调度器。

详细合同：[知识库](docs/guides/knowledge.md)、[业务操作](docs/guides/business-actions.md)、[网站集成](docs/guides/integration.md)。
