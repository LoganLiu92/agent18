# 将 agent18 接入一个已有项目

这份任务书面向拿到仓库 URL 的开发者或编码助手。先阅读本页，再按链接实现具体合同，最终在目标项目交付一份[接入验收报告](docs/reference/integration-acceptance.md)。仓库测试通过只证明 agent18 的本地实现；目标系统的登录、模型、业务授权和线上效果需要在那里验证。

[//]: # (agent18:release:start)

当前版本：**0.7.0 集成预览**。实现范围见[运行机制综述](docs/overview/agent18-0.7-operations.md)；源码自托管，单机部署。

[//]: # (agent18:release:end)

## 接入后应该看到什么

| 阶段 | 网站里的实际效果 | 必须接好的依赖 |
| --- | --- | --- |
| A：知识与支持 | 登录后右下角只有一个对话入口，回答附引用，能提交问题、补充说明、看进展和工作人员回复 | 独立 Core/Worker、真实身份签发、已发布的客户知识、SDK 挂载 |
| B：实时查询 | 说“查看订单详情”，补充订单号后返回当前业务数据和查询时间 | 已审核的查询定义，SaaS 验证 Support Token 与对象权限 |
| C：确认办理 | 说“修改备注”，先看具体变更预览，点击确认后拿到回执，原页面刷新并显示真实变更 | SaaS prepare/execute/status 业务桥、事务化幂等回执、前端刷新回调 |
| D：问题排查与巡检 | 上报时预览页面上下文；后台查询日志/指标并生成报告；工作台合并异常、接手、恢复和生成知识草稿 | SDK 隐私标记、traceId、HTTP/Loki/Prometheus 地址、可信 scope 标签和只读凭据 |

浮窗和内嵌入口通过对话持续引导；独立 `/support` 页面由 SaaS 按钮打开并交接短期身份。普通聊天刷新后重置；已提交的问题、跟进和操作提案会持久化。支持人员目前使用部署主机上的本地工作台回复，尚无面向远程客服团队的管理 SSO。

已有文档和代码可自动形成带来源的知识草稿。模型可整理条目、归纳答案和辅助意图识别，但草稿仍需审核发布；未配置模型时提供原文检索与确定性引导。0.7 已接通 HTTP / Loki / Prometheus 观测与证据分析；分析是待核实假设。网页点击、自动改代码、完整 Trace 关联和多步自主业务执行不属于当前开箱验收项。

## 哪些东西部署在哪里

| 位置 | 接入方要做的工作 | 参考 |
| --- | --- | --- |
| 独立 agent18 目录/部署主机 | 运行 PostgreSQL、OPA、Core、Worker，配置域名、模型、知识来源和备份 | [安装](docs/guides/installation.md)、[运维](docs/guides/operations.md) |
| 现有 SaaS 后端 | 从真实登录会话签发短期 Support Token；映射用户、租户和角色；实现受控查询与业务桥 | [身份接入](docs/guides/integration.md)、[查询](docs/guides/business-queries.md)、[写入](docs/guides/business-actions.md) |
| 现有 SaaS 前端 | 登录后挂载 SDK，接入路由/实体上下文，退出或切换身份时销毁；成功办理后刷新业务数据 | [SDK](docs/reference/api.md)、[对话生命周期](docs/guides/conversation.md) |
| 部署者本地工作台 | 选取客户可见资料、审核发布、审核能力和字段、查看并回复客户问题 | 本机 `http://localhost:4321/setup` |

agent18 不需要接管 SaaS 的业务数据库。最终业务读写仍在 SaaS 后端进行。前端请求 agent18 API，Core 携带当前 Support Token 调用登记的业务接口；不是模拟点击页面，也不是用管理员 API Key 代替用户。完整仓库读取权限不能代替这一步业务适配。

## 1. 先在目标仓库确认接入点

在目标项目记录下列事实，沿用其现有技术栈和发布流程：

- 登录会话在哪里验证，用户/租户/角色从哪里取得，CSRF 和撤权如何处理。
- 前端公共布局、登录完成事件、路由上下文、退出登录和租户切换的位置。
- 一个只读、可检查对象所有权的业务；一个可回读、可撤销、低风险的写业务。
- 客户可见操作指南/FAQ 的位置，内部代码的范围，以及可访问的只读 Git ref。
- SaaS Origin、Core HTTPS 域名、Core 到模型/业务接口的网络地址，部署与备份位置。

先完成 A，再接 B、C、D，未接入项在报告中明确记录。不能为了让演示通过而修改用户权限或换成全局管理身份。

## 2. 安装独立服务

需要 Node 24.14.x、pnpm 11.19.0、Docker Compose v2。下面在 **agent18 目录** 执行。仓库当前没有发布官方 npm SDK 或容器镜像，按源码构建，不要猜测包名或镜像地址。

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
# 记录当前 git rev-parse HEAD；正式部署固定验收过的提交
pnpm install --frozen-lockfile
pnpm run setup
pnpm deploy:start
pnpm setup:ui
```

这是仅绑定回环地址的初始化服务，未启动示例 SaaS。`setup` 初始生成演示项目元数据与随机密钥；在工作台选择连接自己的系统，注册真实项目后再执行第 7 步公开部署。不要此时直接发布到公网。若只想体验完整合成示例，另用 README 的 `pnpm start`，会包含 4319 演示服务。

工作台只监听本机 4321，使用终端显示的访问码。远程主机通过 SSH 本地端口转发访问，保持浏览器地址为 `http://localhost:4321/setup`。密码、公钥以外的密钥和 `.local/` 留在部署端，不提交目标仓库或接入报告。

## 3. 接上真实登录和对话入口

1. 按[身份指南](docs/guides/integration.md)在 SaaS 后端增加 `POST /api/support-token`，沿用真实会话和 CSRF；返回 `{ "token": "..." }`，设置 `Cache-Control: no-store`。用户、租户和角色由后端推导，不能由请求 body 任意指定。
2. SaaS 保管 Ed25519 私钥，agent18 只配置公开 JWKS、固定 issuer/audience、独立组织/项目 UUID、项目 key、精确 allowedOrigins 和已知租户。新租户必须登记；当前不会根据首次登录自动开通租户。
3. 在已登录的前端公共布局挂载 `mountFloatingAssistant`。`getToken` 调用现有后端并按该项目方式传 CSRF。路由变化可用 `client.setContext` 传页面路径、通用实体和已有 traceId；这些是调查线索，不是授权来源。不要手工把用户身份塞进上下文。
4. 在注销、切换用户/租户、布局卸载时销毁面板、SDK 和独立支持页连接。`onActionComplete` 仅在成功回执后刷新 SaaS 自身的数据缓存/页面。
5. 校验站点 CSP、精确 Origin 与模块加载。独立页必须由用户点击调用 `openSupportPage`；跨源 COOP 限制或弹窗拦截时采用同页浮窗。Token 不放 URL 或浏览器持久存储。

后端签发代码与完整前端挂载/销毁示例见[身份指南](docs/guides/integration.md)。`examples/identity-bridge` 是可运行的合成 SaaS：可以参考协议及事务实现，但其固定用户选择器和签发入口不能作为正式登录。

## 4. 用目标系统自己的资料建立知识

在工作台选择刚登记的真实项目，配置来源并核对项目 key。客户指南设为 `customer`，内部代码设为 `internal`；只选明确的文件范围。Git 建议固定到目标系统此次部署的 commit，便于解释引用与版本差异。

先以 `extractive` 模式构建一个小范围，检查文件数、跳过原因、文章正文、引用行号和受众后发布。再配置自有模型并测试实际连通性，切换 `model` 模式评估总结质量。完整范围、格式、预算和供应商参数见[知识指南](docs/guides/knowledge.md)。

至少准备 5 个具有已知正确答案的产品问题，从真实用户浮窗验证回答、引用和内部资料不可见。源码仅作为内部来源时不会直接为客户返回其内容；需要业务人员提供或审定客户可见的说明，不能把整个代码仓库公开来填补文档缺失。

后续用 `knowledge watch` 生成变化草稿，由部署者审核发布。当前没有向量检索、PDF/OCR 或自动覆盖完整大型仓库的保证。没有答案时应明确补知识或转交支持，不以模型流畅度作为验收依据。

## 5. 选择性接入真实业务

**查询：** 导入目标项目的 OpenAPI JSON，只选择已确认无副作用的 GET，审核角色、参数和展示字段。Core 会转发 Support Token；若现有接口只接受原系统会话/其他 JWT，就在 SaaS 信任域内增加适配端点，验证 Support Token 后调用原有服务层与对象授权，不是仅靠设置基础 URL 就能完成认证转换。

**写入：** 按[业务桥协议](docs/guides/business-actions.md)实现固定 POST 端点的 prepare/execute/status。prepare 只读并返回具体变更和 revision；execute 再检查当前权限、对象归属、业务版本，将业务变更和幂等回执同事务保存；status 只读同一回执。网络结果不确定时只核对状态，不自动重发写入。

先用一个测试账户的偏好或备注验证：查询原值 → 生成预览但数据不变 → 点击明确确认 → 得到回执 → 从原系统页面/API 回读新值 → 重复确认不重复写入。再验证另一用户、另一租户、撤权和版本过期。这些检查应复用目标项目的测试框架和数据库断言，不能只截取助手说“成功”的画面。

## 6. 接上页面报告和监控

按[监控接入指南](docs/guides/observability.md)配置 SDK 的采集选项，为客户机密区域标记 `data-agent18-private`，在真实页面验证文字/截图预览、取消附带与身份切换。宿主显式传入失败请求 traceId、当前实体，不能将它们视为授权。

连接已有 HTTP 健康地址、Loki 和 Prometheus，不必搬迁监控存储。Owner 保存固定项目范围和只读凭据；业务日志具有真实 tenant/subject 标签。让受控测试错误出现在真实日志，提交一个有 traceId 的工单，检查 Worker 报告与客户安全摘要，再验证周期巡检、重复合并、恢复和内部知识草稿。没有上游日志/指标时应标明未接入，不能把空结果当成完整线上巡检成功。

## 7. 发布与验收

真实项目知识已发布并启用 `indexed`，HTTPS Origin 与业务接口已准备后：

```sh
pnpm backup
pnpm deploy:prepare your-saas https://support.example.com
pnpm deploy:start
# 曾运行过 demo 时执行：
docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml stop identity-demo
pnpm run doctor
```

把示例 key 和域名替换为实际值。`deploy:prepare` 只保留选中的真实项目于活动配置，备份旧配置且保留数据库；它检查 indexed 设置，但不证明文章已经发布或 SaaS 权限正确。`deploy:start` 构建镜像、运行迁移，重建 OPA/Core/Worker 以加载最新配置，正常配置更新不重建 PostgreSQL；服务会短暂不可用，单机版本不提供滚动零停机发布。

按[公开部署](docs/guides/installation.md)设置 DNS、TLS 与反向代理，只公开 Core。保持数据库、OPA、工作台和演示签发器不对公网提供入口。在目标项目沿用其功能开关或部署配置，先对测试账户开启浮窗；固定 agent18 提交、SDK 产物校验和、目标项目提交和已发布知识版本。

从真实域名完成[接入验收报告](docs/reference/integration-acceptance.md)中的对应项目。`pnpm run doctor` 是服务/配置诊断，不证明业务授权、模型回答质量或 Worker 能完成新任务；必须提交一个真实测试问题，看到 Run 结束及支持回复。首次上线应使用允许测试的业务数据和测试账户，遵循目标项目既有发布审批与维护窗口。

出现问题时先关闭宿主网站助手入口，或停用某个能力并应用 Core 配置。业务撤权必须由 SaaS 实时执行；移除按钮不等于使已签发 Token 立即失效。保留 requestId、Case/Run、proposal 和业务回执标识以便追踪。代码/数据库回退按[备份恢复指南](docs/guides/operations.md)操作，不能把降级镜像当作数据库迁移回滚。

`pnpm test:integration`、`test:recovery` 和 `test:journey` 用于 agent18 自身的本地合成环境，部分测试会暂停服务；不要把这些环境变量指向线上实例。线上验收应使用目标项目自己的受控账户和下方报告。

## 可以发给另一个项目的任务描述

> 请将 https://github.com/LoganLiu92/agent18 集成到当前项目。先读取 README.md、INTEGRATE.md 和 docs/reference/integration-acceptance.md，核对当前版本边界；再检查本项目的登录、租户权限、前端布局、业务 API、文档和部署方式。沿用本项目技术栈，实现真实会话签发 Support Token、浮窗挂载与身份切换清理、客户知识审核发布，验证问题与支持回复。之后选择一个只读业务和一个可回读的低风险写业务，按 agent18 合同适配并验证授权、预览、确认、幂等和不确定回执。同时按 docs/guides/observability.md 接入页面上下文和现有 HTTP/Loki/Prometheus，验证真实错误关联、客户隔离、周期巡检与恢复；缺少数据源时明确记录依赖。按本项目的部署流程接入 HTTPS、配置、功能开关和备份；记录固定提交与实际证据。不要用演示签发器或管理员身份替代真实权限，不要把本地演示成功当成线上验收。输出接入改动、实际运行效果、通过/失败/未测试项目和仍需提供的信息，产出 INTEGRATION_REPORT.md；按本项目既有授权范围完成上线步骤。
