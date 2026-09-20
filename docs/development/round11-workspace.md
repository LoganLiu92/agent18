# 第十一轮：正式后台工作空间与知识文档闭环

后续更新：[第十二轮](round12-source-workflow.md)已补来源向导、扫描任务、历史对照与退回原因；下文保留本轮交付时点的范围。

本轮将参考页面的信息架构接入现有 React Console 的 `/admin`，不交付独立 HTML 原型。适用未发布的开发版本；需迁移 012 并构建 Console。未修改正在运行的演示数据库，也不代表目标网站已完成接入验收。

## 已实现范围

- 统一深色导航、项目选择、概览、知识中心、集成状态、工作人员、审计及账号管理；项目与页面选择记录在 URL。
- 知识目录复用真实 `knowledge.sources/builds/articles`，展示分类、正文、文件行号、来源版本与构建时间。来源版本不代表线上部署版本。
- 人工补充文档持久化到 `knowledge.documents`；`document_history` 保存每次流转的不可变正文快照、修订号、操作者和时间。前端展示流转记录，历史正文比较尚未实现。
- 草稿 → 提交审核 → 审核通过 → 发布；支持退回和撤回。保存新正文回到草稿，原线上版本继续生效。乐观版本号阻止并发覆盖，状态变更也递增版本。
- 发布事务创建专属 `staff-<documentId>` 来源及不可变 build/article，原子切换 active build。客户继续使用原有 KnowledgeProvider；无需新建第二套检索通道。
- 默认内部受众；客户受众明确为本项目所有租户。此入口暂不创建指定租户的私有文档。内部内容不进入客户检索。
- 项目使用 `knowledge: fixture` 时，后台提示客户仍读取演示资料；部署者需配置 `indexed` 才使用已发布内容。
- 集成页只投影当前配置是否存在，不返回地址、密钥、查询模板或连接凭据，不把已配置当作健康检查通过。

## 权限和接口

独立工作人员 Cookie / CSRF / Origin 校验沿用 A01/A02。所有接口在 `/operator/projects/:key` 下：

| 方法和路径 | 行为 | 权限 |
| --- | --- | --- |
| `GET /workspace` | 项目及脱敏集成配置摘要 | project.read |
| `GET /knowledge` | 真实计数、来源、当前文章、补充文档 | source.read |
| `GET /knowledge/articles/:id` | 当前启用版本正文和证据 | source.read |
| `GET /knowledge/documents/:id` | 当前草稿及流转记录 | source.read |
| `POST /knowledge/documents` | 创建草稿 | knowledge.edit |
| `POST /knowledge/documents/:id` | 保存、提交 | knowledge.edit |
| 同上，action 为 approve / return | 审核或退回 | knowledge.review |
| 同上，action 为 publish / revoke | 发布或撤回 | knowledge.publish |

创建正文为 `{title, body, category, audience}`。变更为 `{version, action, content?}`，仅 save 接受 content。400 表示参数或疑似密钥，403 为权限不足，404 为不可见对象，409 为修订或状态冲突。冲突后重新读取，不自动覆盖。

来源和内部正文只对 engineer / knowledge_editor / knowledge_publisher 及部署管理员开放。viewer / support 不因同项目而获得内部资料。单人自托管管理员可以编辑、审核、发布，操作均记录真实身份。强制双人复核仍为后续策略。

迁移 012 通过活跃会话、当前项目成员关系和事务级 scope 扩展 RLS；客户请求不设置 operator session。旧来源仅可读，工作人员发布仅能写 `staff-<id>` 专属来源。文档历史及 operator audit 不授予应用 UPDATE / DELETE 权限。后台接口不使用 indexer / owner 数据库凭据。

## 明确保留的后续工作

这是一段已可运行的正式应用实现，不代表 K01–K07 全部完成：

1. K01：完整 Topic / Evidence / SourceSnapshot 关系、旧来源映射、独立 Revision / ReviewDecision / Publication 合同；当前历史快照并非最终完整模型。
2. K02–K04：后台来源连接表单、异步扫描、范围确认、知识地图、生成任务与取消重试。当前仍通过本地向导 / CLI 连接和构建。
3. K05：退回原因、版本差异、回滚、批量发布、幂等键及完整分页；当前限制 200 来源、200 文档、500 文章并明确提示截断。生成文档仍沿用原有 Owner 构建发布流程。
4. Support / Operations：导航页显示待接通；需明确工作人员租户授权后接入真实工单、回复、分配及内部运行证据。
5. Insights：需先注册批准的分析接口；没有模拟指标、虚构健康状态或占位成功操作。

## 验证与启动

`pnpm test:operators` 在随机命名的独立数据库运行全部迁移，测试编辑/审核角色隔离、并发版本、发布前不可见、修改保留旧版本、客户转内部、撤回、跨项目拒绝、客户 RLS 和追加审计。不会迁移现有演示数据库。

开发环境部署流程仍为：备份目标环境 → 执行迁移 → 构建 → 重启服务 → 用独立工作人员账号打开 `/admin`。迁移及服务更新属于部署步骤，本轮未对现有运行环境执行。
