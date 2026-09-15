# 配置参考

部署配置保存在 `.local`，生成文件默认仅当前系统用户可读写。所有 JSON 都由服务端 schema 校验；本地工作台只返回必要的配置元数据，不回显数据库密码、Worker Token 或模型 Key。

## 文件与生效时机

| 文件 | 内容 | 生效方式 |
| --- | --- | --- |
| server.json | 宿主机 Core 地址、数据库、OPA、项目身份和业务注册 | 宿主机 Core 重启 |
| server.docker.json | 容器 Core 对应配置 | 重新创建 Core 容器 |
| worker.json / worker.docker.json | 队列、Core 内部地址和工作负载 Token | 重新创建 Worker |
| migration.json / migration.docker.json | 一次性迁移的管理账户与初始角色密码 | 仅迁移命令使用 |
| indexer.json | 权限受限的知识索引账户 | CLI / 工作台构建时读取 |
| model.env | 模型接口与 Key | Core 重新创建；CLI 启动时加载 |
| knowledge.json | 向导当前选择的项目知识配置 | 保存后下一次构建读取 |
| knowledge.PROJECT.json | 工作台按项目保存的知识配置 | 切换项目时恢复，可供独立 watch 使用 |
| setup-access | 本地部署者访问码 | setup:ui 启动时读取 |
| identity.json | 仅演示 SaaS 使用的签名私钥与公钥 | 演示服务重启 |
| compose.env | 配置目录、容器 UID/GID | Compose 创建时读取 |

`AGENT18_LOCAL_DIR` 可改变脚本的配置目录；`AGENT18_CONFIG`、`AGENT18_WORKER_CONFIG`、`AGENT18_MIGRATION_CONFIG` 指定各服务配置文件。知识 CLI 使用 `AGENT18_KNOWLEDGE_CONFIG` 选择一个独立项目的文件。

业务注册更新会保留当前宿主机和 Docker 的不同地址；工作台可明确设置容器内的查询地址。重新配置身份不会覆盖既有业务注册。

JSON 写入采用同目录临时文件加 rename，避免半写入。多个 JSON 文件与数据库元数据不构成一个分布式事务；保存失败时应修正原因并重试同一个操作，运行中的服务保持上一次加载的配置。CLI 与工作台不应同时编辑同一份部署配置。

## 项目身份

必填项目字段：`key`、`organizationId`、`projectId`、`issuer`、`audience`、`jwks`。`allowedOrigins` 为精确网站 Origin 数组；`displayName` 用于页面名称。

组织、项目 UUID 与公开 key 在注册后不能重新分配给别的身份。租户只允许由部署者注册；客户自报 tenantId 不会建立租户。更新租户列表是新增/更新，不执行删除。

Support Token 使用 Ed25519/EdDSA，带 `kind: customer`、`project_key`、`tenant_id`、`roles`、`sub`、`iss`、`aud`、`iat`、`exp`。最长寿命 10 分钟。当前采用静态公开 JWKS；远程 OIDC discovery、自动 JWKS 刷新、Token exchange 尚未实现。

## 模型

| 环境变量 | 作用 |
| --- | --- |
| AGENT18_MODEL_BASE_URL | 兼容模型的基础地址，如 HTTPS /v1 |
| AGENT18_MODEL_NAME | 具体模型名 |
| AGENT18_MODEL_API_KEY | 服务端密钥 |
| AGENT18_MODEL_MAX_TOKENS | 单次生成输出 Token 上限，范围以 model schema 为准 |
| AGENT18_MODEL_TOKEN_LIMIT_FIELD | max_completion_tokens 或 max_tokens |
| AGENT18_MODEL_JSON_MODE | 是否发送 JSON object 模式参数 |

模型连通测试与保存分开；保存 Key 后不能从界面读回。留空 Key 表示保留已保存密钥。模型字段和能力的可用性需要按所选供应商验证。未配置模型时知识原文索引、检索、业务表单、问题跟进仍可运行。

## 业务与知识

`businessQueries` 的完整约束见[查询指南](../guides/business-queries.md)，`businessBridge` 见[办理协议](../guides/business-actions.md)。注册工具默认关闭，必须配置角色和允许参数。客户 Token 不能创建、启用或修改注册。

知识来源包含 id/name/kind/location/ref/include/exclude/audience/tenantIds，以及 maxFiles/maxTotalBytes/maxFileBytes。知识模式为 extractive 或 model；每个来源独立构建、发布。详见[知识指南](../guides/knowledge.md)。

## 固定运行预算

- Core 普通请求体 16 KiB；本地 OpenAPI 导入端点单独允许 550 KB 请求体。
- 模型与业务昂贵调用每实例最多 4 个并发，每用户每分钟最多 20 次；不是跨实例全局配额。
- 业务查询 10 秒 / 256 KB / 50 条，业务桥 10 秒 / 16 KB，预览确认窗口 5 分钟。
- 客户问题列表最多 100，单问题消息最近 100 条，办理记录最近 20 条。
- Run 尝试次数、时间预算、取消和恢复规则由数据库及应用层共同检查。

公开服务需要在反向代理和业务 API 侧配置符合自身流量的速率、资源与连接限制；当前内置预算不等同于完整 API 防滥用平台。

## operations 与观测凭据（0.7）

项目可选 `operations` 保存 enabled、autoInvestigate、intervalSeconds、modelAnalysis 与最多八项 checks。检查支持 http / loki / prometheus，schema 见 `providers/observability/src/config.ts`，完整示例见[监控配置](../guides/observability.md)。默认 disabled、300 秒周期、自动关联工单、模型分析关闭。

只读 Bearer 值保存在 `.local/observability.env` 的 `AGENT18_OBS_*` 变量，配置只引用 `credentialEnv` 名称。Owner 保存后应用配置，Core 重新创建以加载环境文件。不要提交秘密文件或在前端配置中复制值。
