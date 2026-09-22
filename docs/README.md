# agent18 使用与开发手册

agent18 是一个嵌入现有 SaaS 的开源支持与业务助手。它连接已有文档、代码、模型和用户身份，让客户找答案、查业务、经确认办理业务，并让支持人员接着处理尚未解决的问题。

[//]: # (agent18:release:start)

当前版本：**0.8.0 集成预览**。实现范围见[运行机制综述](overview/agent18-0.8-integration.md)；源码自托管，单机部署。

[//]: # (agent18:release:end)

知识与业务对话已连接页面问题上报、HTTP/Loki/Prometheus/Tempo 排查、周期巡检、异常恢复与内部知识草稿。[监控接入指南](guides/observability.md)提供真实组件演示和配置，[进阶工作流](guides/advanced-workflows.md)说明 Tempo、部署证明、外部工单与分析合同；[公开路线图](planning/mvp-roadmap.md)记录剩余工作与验收条件。

将仓库交给一个已有项目接入时，从[接入任务书](../INTEGRATE.md)开始，最终填写[目标系统验收报告](reference/integration-acceptance.md)。

长期开发按[知识中心、工单与 Insights 分步计划](planning/product-development-plan-20260918.md)推进；计划同时保留后续扩展，当前源码交付以[第十七轮开发记录](development/round17-product-workflows.md)及使用指南为准，不代表活动部署已经升级。后续接入复核见[第十八轮](development/round18-integration-review.md)。

逐步实施可直接按任务编号开展：[M1 独立账号与知识中心](planning/m1-work-packages.md)、[知识中心页面与接口方案](planning/knowledge-center-delivery-design.md)、[M2—M4 工单与 Insights](planning/support-and-insights-work-packages.md)。共同约束见[产品领域合同](architecture/product-contracts.md)，本地实现及未验证项见[第九轮开发记录](development/round9-foundation.md)。

正式后台本轮实现见[工作空间与知识文档闭环](development/round11-workspace.md)：统一导航、真实知识目录、人工文档审核发布；新增[来源向导与扫描闭环](development/round12-source-workflow.md)，工单及洞察的后续实现见第十六轮记录。

2026-09-19 分享方案中的完整产品流程和 v2 页面参考已对齐到[正式开发计划](planning/product-development-plan-20260918.md)，列明当前差距、共用界面约束与下一批验收顺序。

[第十三轮](development/round13-knowledge-map.md)已补客户引用投影和人工业务主题地图：范围确认、文档关联、有效发布缺口；自动产品理解与完整证据关系仍待继续。

[第十四轮](development/round14-source-evidence.md)补齐独立来源快照、文件证据、历史映射及主题证据关联；正式页面可以记录支持、反驳与人工核对状态，其后续分层生成见第十五轮记录。

[第十六轮](development/round16-support-workspace.md)已将持久对话、正式工单、工程调查、支持指标/报告、知识维护/评测、保留删除和知识 Worker 纳入框架。[正式后台指南](guides/support-workspace.md)说明完整接入顺序、实际页面及运行边界。

## 按你的任务开始

| 你要完成的任务 | 从这里开始 | 完成标志 |
| --- | --- | --- |
| 将仓库交给现有项目集成 | [接入任务书](../INTEGRATE.md) | 真实登录、知识、业务与部署分别有实际验收证据 |
| 第一次下载并运行 | [安装与公开部署](guides/installation.md) | 健康检查成功，能打开向导和示例 SaaS |
| 运作知识、工单与洞察后台 | [正式后台指南](guides/support-workspace.md) | 员工租户授权、回复/解决/知识回流、报告与来源维护 |
| 管理独立后台账号 | [后台账号与恢复](guides/operator-accounts.md) | 初始化、授权、会话撤销与本地恢复；适用开发版本见指南 |
| 连接已有登录和网站 | [网站与身份接入](guides/integration.md) | 自己的用户能访问，另一用户不能读其问题 |
| 从现有代码、文档生成知识 | [知识构建与更新](guides/knowledge.md) | 草稿有引用，发布后客户能检索，内部资料不可见 |
| 查询订单等业务状态 | [OpenAPI 业务查询](guides/business-queries.md) | 返回当前用户有权访问的业务记录和批准字段 |
| 让助手代办业务 | [代操作协议](guides/business-actions.md) | 先预览，再确认，数据与业务回执一致 |
| 维护线上运行 | [运维指南](guides/operations.md) | 诊断可执行，备份通过隔离恢复演练 |
| 自建页面或接入客户端 | [API 与 SDK](reference/api.md) | 使用同一套身份、错误和幂等语义 |
| 理解配置与技术边界 | [配置参考](reference/configuration.md)、[技术标准](reference/standards.md) | 清楚配置在哪生效、由谁授权、如何恢复 |
| 接上日志与巡检 | [页面采集与监控](guides/observability.md) | 数据源、标签、权限、异常处理与恢复 |
| 让助手理解刚才失败的业务 | [宿主业务事件](guides/semantic-context.md) | 路由/实体、事件、预览、工单与工程证据关联 |
| 了解整体实现 | [0.7 运行综述](overview/agent18-0.7-operations.md)、[0.6 核心抽象](overview/agent18-0.6-core.md) | 从用户请求追溯到接口、策略、存储和回执 |
| 选择贡献方向 | [路线图](planning/mvp-roadmap.md)、[评审核验](planning/review-and-priorities.md) | 确认优先级、依赖与验收条件 |

## 最短体验路径

```sh
pnpm install --frozen-lockfile
pnpm start
```

进入部署终端显示的 `http://localhost:4321/setup`，使用访问码登录。首次安装按向导配置；安装完成后默认进入接入工作台。示例网站位于 `http://localhost:4319/example`，Core 首页与文档位于 `http://localhost:4318` 和 `/docs`。

1. 用文档来源构建原文索引；没有大模型 Key 也能验证引用与检索。
2. 审查并发布构建，在示例 SaaS 的浮窗中查找资料。
3. 在浮窗中输入“查询我的订单”；换成另一个用户后再次查询，验证隔离。
4. 输入“关闭邮件通知”，核对预览并点击确认，再查询通知偏好核验实际状态。
5. 在 Setup 初始化管理员，再用 `/admin` 的独立员工账号和租户授权回复客户问题；客户侧刷新查看，确认解决后可重新打开。
6. 运行 `pnpm run doctor`，再按运维指南进行一次备份恢复演练。

示例身份和订单是合成数据，但业务查询确实访问独立 HTTP 服务，通知偏好确实写入 SaaS 自己的 SQLite，客户问题确实持久化到 PostgreSQL。模型未配置时不会把检索结果伪装成模型回答。

浮窗和内嵌助手采用一个消息流与输入框，按对话逐步引导；参见[对话式助手](guides/conversation.md)。

## 你需要提供什么

- 运行服务的主机与 Docker、代码/文档的读取权限；可选的大模型 API。
- 现有系统后端的短期身份签发入口，以及登记的租户与公开公钥。
- 开放给助手的业务接口。查询可以从 OpenAPI 导入；写操作需要实现三阶段桥接。
- 客户可公开的资料范围、允许使用业务能力的角色、业务对象的真实授权规则。

给出代码与 Key 可以自动构建知识，但不会自动获得业务授权。接入者只需实现明确的身份和业务边界，不必迁移原系统用户、业务数据库或前端架构。

## 页面与角色

| 页面 | 使用者 | 作用 |
| --- | --- | --- |
| `/`、`/docs`、`/openapi.json` | 接入者、开发者 | 项目介绍、随版本更新的文档、机器可读 API |
| 本地 `4321/setup` | 部署者 | 初始化、知识审核发布、接口导入、运行诊断、客户收件箱 |
| SaaS 内浮窗、内嵌区块 | 已登录客户 | 找答案、查业务、办业务、问题与回复 |
| `/support` | 从 SaaS 打开的已登录客户 | 同样的功能，适合独立页面使用 |
| `/admin` | 独立工作人员账号 | 知识中心、工单、调查、洞察、成员、租户范围及审计；见开发版本说明 |
| `/console` | 本地演示与测试人员 | 固定演示身份工作台，不作为正式管理员后台 |

管理员访问码与客户 Token 完全分开。公开部署只代理 Core，不对外开放本地管理服务、演示签发器、OPA 或数据库。

## 0.6 Core Foundation

[核心抽象、数据迁移与范围](overview/agent18-0.6-core.md) · [Provider / Tool 注册与审核](reference/providers.md)。

[第十五轮](development/round15-layered-generation.md)将固定原文核对、按主题分层生成、持久任务、独立客户稿及来源新鲜度接入正式知识中心。模型结果仍需导入草稿并人工审核发布。

知识治理、批量发布、业务分析与 Playbook、定期报告、SLA、外部工单桥、Tempo 和部署证明，参见[进阶工作流指南](guides/advanced-workflows.md)。
