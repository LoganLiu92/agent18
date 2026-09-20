# 诊断、备份与恢复

这些工具面向仓库内的单机 Compose 部署。外部托管数据库、分离的队列数据库、外部对象存储和模型供应商需要使用各自的运维方案；不能用一次本地备份代表所有外部依赖已经备份。

## 运行诊断

```sh
pnpm run doctor
pnpm run doctor --json
pnpm run doctor --strict
```

工作台“运行总览”展示同一套实时诊断：应用数据库账户不能绕过 RLS，关键表必须强制 RLS，迁移版本与代码校验和一致，Core readiness 与 OPA 策略可用，调度是否积压，模型与初始化是否配置，是否仍使用演示身份。

诊断只读取必要配置和聚合状态，不输出凭据或客户业务正文。`ready` 表示没有失败项，警告仍需按具体用途处理；`--strict` 会让任何警告导致非零退出。模型“已配置”不等于连通性验收，实际调用用向导中的“测试连接”。队列无积压不证明空闲 Worker 活着，端到端提交 Case 才能验证后台执行链路。

## 查看与定位问题

```sh
pnpm logs
```

客户错误有稳定 code 和 requestId。按 requestId 对照 Core 的安全事件与业务审计，先看授权/参数，再看模型、业务桥和队列。不要把完整 Authorization、客户问题或上游错误原文加入日志。

| 情况 | 处理路径 |
| --- | --- |
| MODEL_NOT_CONFIGURED | 使用原文检索，或测试并保存模型配置，重新创建 Core |
| ORIGIN_DENIED | 核对宿主站点精确 Origin 与项目归属 |
| QUERY_NOT_ALLOWED | 检查 enabled、角色和 Core 是否已重新加载注册 |
| BUSINESS_NOT_ACCESSIBLE | 让 SaaS 核实当前用户对象权限，不切换成管理身份重试 |
| BUSINESS_RESPONSE_INVALID | 核对 JSON 响应结构、响应体预算、延迟和字段定义 |
| ACTION_CONFIGURATION_CHANGED | 旧预览作废，按最新配置重新生成预览 |
| executing / uncertain | 先查询业务回执，不创建重复操作来猜测是否执行 |
| 积压或失败 Run | 查看步骤和原因；恢复依赖后显式重试，遵守次数/时间预算 |
| BUILD_POLICY_CHANGED | 受众变化后重新构建审核，不复用旧权限版本直接发布 |

## 本地备份

```sh
pnpm backup
# 或指定一个尚不存在的目录
pnpm backup .local/backups/before-upgrade
```

备份使用 PostgreSQL `pg_dump -Fc` 获取数据库一致快照，包含 Case、消息、运行、证据、审计、队列、知识版本与业务提案。它同时复制配置文件；示例 SaaS SQLite 使用在线 backup API，而不是复制可能未刷盘的数据库文件。

目录权限为 700、文件为 600。`manifest.json` 记录版本、时间、文件大小和 SHA-256。**备份包含模型 Key、数据库配置与可能的演示私钥，应按秘密文件管理**。工具不会上传备份；需要离机备份时使用自己的加密存储和保留策略。数据库快照与配置复制、示例 SaaS 快照不是跨系统同一事务；升级前先停止配置变更，必要时进入业务维护窗口。

只支持 Compose 内同一 PostgreSQL 承载 Core 和队列的配置；遇到外部或拆分数据库会拒绝，避免导出错误数据库并误报完整备份。

## 实际恢复演练

```sh
pnpm backup:verify .local/backups/before-upgrade
```

这个命令先逐文件校验 SHA-256，然后在当前 PostgreSQL 实例创建一个随机命名的 `agent18_restore_*` 新数据库，执行真实 `pg_restore`，核验关键表及迁移能读、无 scope 的应用账户看不到问题、消息和提案。结果输出恢复后的行数；最后删除**本次自己创建的临时数据库**。它不会覆盖或暂停活动数据库。

演练证明当前备份可以在本地 PostgreSQL/角色环境中恢复，并验证基础隔离；它不证明上游 SaaS、模型、DNS、SSO、业务回执和真实用户入口都已经恢复。恢复后的业务回执必须继续向 SaaS 核对。核验会读取问题、消息、知识、提案与迁移计数，并验证无 scope 的应用读取为零；它不是完整跨版本兼容检查。当前恢复脚本先在新库应用缺失迁移并核对已有校验和，然后重新应用活动库的删除账本；不兼容的历史校验和会拒绝，不能跳过检查。激活并部署后用 doctor 检查当前迁移及校验和。

## 恢复并切换

```sh
pnpm restore .local/backups/before-upgrade
# 输出一个新的、已验证的数据库名称；此时保留活动部署不变。
# 维护窗口内停止旧消费者；同时停止主机上直连旧库的索引/维护进程。
docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml stop server worker knowledge-worker
pnpm restore:activate agent18_restore_REPLACE_WITH_RETURNED_NAME
pnpm deploy:start
pnpm run doctor
```

`restore` 保留新数据库，并记录本地验证标记；`restore:activate` 只接受它创建并验证过的名称。激活会备份并修改 Core、Worker、索引器、迁移器的宿主/Docker 数据库配置；不恢复旧的访问密钥，不覆盖原数据库，不自动切换外部 SaaS。

包含独立后台账号的开发版本会在隔离恢复与激活前撤销恢复库中的员工会话；账号、授权和历史审计仍按备份还原。启用前核对恢复后的人员和权限，详见[独立后台账号与恢复](operator-accounts.md)。

激活前必须停止 Core、执行 Worker、知识 Worker 及其他应用/索引连接，脚本发现活动消费者将拒绝切换。最后一次重放当前删除账本后才修改配置。运行 `deploy:start` 重新创建三个服务并应用数据库切换。完成后从实际 SaaS 验证：登录 → 知识检索 → 业务查询 → 问题详情 → 未确定操作回执核对。

如需回滚，停止新进程，把同时间戳的配置副本全部恢复，再重新创建 Core 和 Worker；原数据库始终保留。不要仅恢复一个 server 文件而漏掉 Worker/队列配置。演示 SaaS 的 SQLite 是独立业务数据，切换 Core 不会自动覆盖它；真实 SaaS 的恢复由其自身负责。

## 保留策略与删除传播

正式后台“接入配置”可以分别设置对话、已解决工单、页面采集附件、运行证据、客户业务审计的保留天数；留空表示关闭自动清理资格，业务审计最少保留 30 天。未解决或有活动调查的工单不会被保留任务清理。

```sh
pnpm retention         # 只预览，不删除
pnpm retention --apply # 显式执行，每项目每类最多 200 项
```

到期项很多时需重复运行或由部署者配置维护调度。保存策略不会立即触发删除。客户主动删除对话/附件不受等待保留期限制；工单与员工安全审计独立保留。已处理的数据写入删除账本，恢复备份时再次擦除，避免旧备份恢复正文。

删除传播仅覆盖 Agent18 内受管理数据；模型/外部日志/下载文件由其各自策略负责，人工整理后的知识有独立审核与生命周期。当前恢复需要活动库的最新删除账本，整库丢失时须另有异地账本保全，不能仅依赖旧全量备份宣称删除保护完备。

`pnpm test:backup:isolation` 自建临时数据库并验证旧结构升级、真实备份恢复、删除传播和激活条件，不暂停活动服务。

## 自动知识更新

```sh
pnpm knowledge watch 300
```

每 300 秒重新读取配置、扫描目录或拉取 Git；30 秒到 24 小时可配置。内容、修订、受众、模型及构建规则签名相同则复用最近就绪构建，避免重复生成。变化产生新草稿，**不会自动发布**。失败保留已发布快照；下轮继续尝试。移除来源或变更受众时会撤下不再允许的旧内容。

正式后台创建的来源任务由独立 `knowledge-worker` 处理，Compose 启动和目录/Git 范围配置见[正式后台指南](support-workspace.md)。下面的 CLI watch 是另一种部署者维护方式，不是后台队列的轮询器。

多个项目使用独立配置文件，例如 `AGENT18_KNOWLEDGE_CONFIG=.local/knowledge.acme.json pnpm knowledge watch 300`。同一项目应由一份完整来源配置管理；同来源并发由数据库 advisory lock 排他。修改模型环境配置需要重启 watch。用主机自己的 systemd/launchd 管理进程日志、重启与访问权限，关闭浏览器不会停止该 CLI。

## 发布与回归

```sh
pnpm check
pnpm test:policy
pnpm test:integration
pnpm test:recovery
pnpm test:journey
```

后几项使用本地合成业务环境。原有恢复测试会暂停并恢复本项目 Server/Worker，不要对正式实例直接运行。journey 创建隔离的临时 Compose 项目完成全新安装旅程，使用独立端口和数据卷，结束后只清理自己创建的资源。

`pnpm release:check` 生成 `.local/release`：SDK ES module、OpenAPI JSON、MIT 许可证和校验清单。发布者可将它们放入自托管静态资源或 GitHub Release；当前没有声称公共 npm 包或预构建镜像已经发布。

## 运行排查与巡检数据

0.7 新增的页面上下文、排查报告、任务、调度和异常状态在 Core PostgreSQL 内，随数据库快照备份；`observability.env` 随秘密配置备份，恢复演练也检查捕获和报告的 RLS。Loki / Prometheus 数据卷不包含在 Core 备份中，应按各组件方案另行备份。内部经验 Markdown 可从报告重新生成。

`pnpm observability:demo && pnpm test:observability` 验证真实监控组件的工单、告警、恢复流程；仅限合成演示环境。接入自有服务器/日志见[监控指南](observability.md)。
