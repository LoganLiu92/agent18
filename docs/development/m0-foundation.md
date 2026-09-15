# M0 基础链路：实现与验收

日期：2026-09-14。用户已授权开始开发，并确定项目名 **agent18**。本次交付为 M0 的可运行基础链路，**M0 整体尚未结项**；第三方集成 Spike 仍是后续工作。

本文保留 **0.1.0 首轮历史记录**。0.2.0 已补齐只读 Run 的取消、预算、有限重试、执行记录和队列失败核对；当前行为与验证见[第二轮记录](round2-20260915.md)及[完整综述](../overview/agent18-overview-20260915.md)。下文“尚待完成”为首轮时点状态。

## 已实现

| 范围 | 实现位置 | 当前行为 |
|---|---|---|
| 身份 | `apps/server/src/auth.ts`、`examples/identity-bridge` | EdDSA 签名、固定 issuer/audience/JWKS、项目绑定、最长 10 分钟有效期；tenant-admin 不提升成 operator |
| 组织与隔离 | `packages/persistence/migrations` | Organization / Project / Tenant；Case、Run、Evidence、Audit 采用 FORCE RLS，按组织、项目、租户、用户隔离 |
| 问题报告 | `packages/application/src/cases.ts` | strict 请求 Schema；Case + 初始 Run + outbox + 审计同事务；同 key 同内容复用、不同内容返回 409 |
| 工具控制 | `packages/application/src/gateway.ts`、`packages/policy` | 已审核的 `knowledge.search` 是唯一可调用工具；OPA 默认拒绝，执行前审计必须提交 |
| 任务持久化 | `packages/application/src/dispatch.ts`、`apps/worker` | pg-boss Job 只存 dispatch ID；服务端路由表决定范围，执行需要工作负载身份和 60 秒租约 |
| 引用证据 | `providers/knowledge-basic`、`packages/provider-contracts` | 三篇合成中文资料；有界检索，校验来源/版本/可见性/范围，返回 customer-safe DTO |
| 客户界面 | `apps/console` | 我的问题、报告/详情、知识检索、接入状态、四种演示身份；清楚显示未连接模型 |
| SDK | `packages/web-sdk` | `setContext`、身份回调、report/list/detail/search、destroy；不采集 Cookie/DOM/请求正文/URL 查询参数 |
| 本地部署 | `deploy/compose`、`scripts` | 固定镜像 digest、非 root 应用、只读容器、独立配置挂载、自动 migration、健康检查 |

Operator / Workload 有类型定义；本次只实装客户身份与固定 Worker 身份。尚无 Operator 管理后台、审批数据表或密钥管理服务，不能把“Worker 无法访问这些能力”描述成已完成审批系统隔离验收。

## 可运行流程

浏览器或 Headless SDK 从独立 demo issuer 取得 Token。Core 通过公钥验证，固定项目配置给出 Organization / Project，Token 提供 Tenant / Subject。创建 Case 的事务同时写入初始 Run、1 小时的只读 Case capability 和 outbox。Dispatcher 将 ID 投到 pg-boss，Worker 申请短期 lease。Core 根据持久化 Run 检查范围与工具版本，通过 OPA 后检索，验证并追加引用证据。最后标记“检索完成，待人工跟进”，不会自动声称故障解决。

知识检索可直接在已验证身份范围内执行，不强迫 FAQ 创建 Case。当前没有真实 Conversation、ModelProvider 或生成式回答。

## 验证证据

- `pnpm build`：TypeScript 严格检查通过；Console 构建通过。Headless SDK 为 1,855 bytes，gzip 在 macOS Node 为 903 bytes、Linux 镜像为 907 bytes，未包含 Widget。
- `pnpm test:integration`：49 / 49 通过，其中 18 个无服务依赖测试和 31 个真实 PostgreSQL / OPA / Compose 测试。
- `pnpm test:policy`：6 / 6 Rego 测试通过，涵盖空输入、跨范围、未审核工具、WRITE、过期 capability 与允许的 READ。
- 接口验证：6 个并发同 key 请求仅创建一个 Case、一个 Run、一个 outbox；错误内容复用返回 409。
- 隔离验证：同项目另一租户、同租户另一用户、另一项目同名租户的列表/详情不泄漏；RLS 无 scope 返回空；越界写返回权限错误。
- 权限验证：Worker 数据库角色不能查询 Core/策略/路由/审计表；App 不能删改审计或修改工具审核状态；运行角色均无 superuser / BYPASSRLS。
- 安全边界：错误签名、issuer、audience、nbf、有效期、project 与 operator Token 均拒绝；OPA 不可用与审计失败不调用 Provider；污染的跨租户输出被拒绝。
- outbox 连接池短暂失效后可继续投递，不会因 busy 状态卡死。
- `pnpm test:recovery`：真实停止 Server/Worker 后，通过独立 API 进程写入未投递 outbox 并关闭进程；重启后恢复原 Run；再次执行已完成 Run 没有新增证据或重复审计。三项断言通过。
- 浏览器验收：提交合成问题后实际 Worker 完成检索；显示两条引用与审计；切换 Northwind 后原 Case/证据清空；知识检索返回原文引用，无浏览器 error/warn 日志。

这些结果证明本地基础链路与上述隔离边界，不证明外部 SaaS、真实模型、Loki/OpenObserve、OpenHands、GitHub 或生产验收。

## 开发方式

一键演示：根目录执行 `pnpm install --frozen-lockfile` → `pnpm run setup` → `pnpm demo:start`。访问 `http://localhost:4318`。

前端热更新：保留 Compose 服务，运行 `pnpm dev:console`，打开 `http://localhost:5173`。Vite 将 `/api` 转发到本地 Server。

后端热更新：先运行下列命令停止本项目的容器 Server/Worker，保留 PostgreSQL、OPA 和 demo issuer，然后在两个终端分别运行 `pnpm dev:server`、`pnpm dev:worker`。

```sh
docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml stop server worker
```

配置文件在 `.local/`，父目录 0700、文件 0600。Compose 以当前用户 UID/GID 运行应用，分别只挂载所需配置；Server 不挂载签发私钥，Worker 不挂载 App/migration 数据库配置。`setup` 幂等且不旋转既有凭据。此版本只支持自动生成的本地配置，正式配置管理及轮转待实现。

PostgreSQL 54328、OPA 8188 和 Server 4318 使用仅回环发布的 host-access 网络；Worker 只在内部 core 网络。demo issuer 4319 在独立网络。Docker Desktop 的 internal-only 网络不发布宿主端口，因此 host-access 是本地 CLI 与浏览器联调所需。

## 关键实现取舍

- 公钥集由服务端配置加载并固定；尚未实现远程 JWKS 下载、缓存和轮转。Token 自带 URL 不会影响公钥来源。
- 不把不可信 OpenAPI 作为 Fastify 动态 Schema。当前请求 Schema 均来自已审阅的源码。
- pg-boss DDL 由一次性 migrator 执行；运行角色只获队列 DML 与所需函数权限，不获 Core 权限或 database CREATE。
- outbox 与 Case 共享事务；投递到队列采用稳定 Job ID，消费端仍独立去重。当前重试耗尽后没有管理台重新派发功能。
- Run 由数据库 advisory lock 串行执行；完成后的重投不会再次调用 Provider。只读调用失败可安全重试；这套逻辑尚不适用于外部写操作。
- 应用审计没有保存模型思维链、JWT、原始请求头或客户日志。数据库管理员的权限不在应用层防篡改承诺内。
- 知识源是固定、公开、合成资料。远程 ACL、撤权、同步、历史引用失效和真正的中文检索评测均未实现。
- Console 是客户演示工作区，不是 Operator Console。状态页“已实现”表示已有实现；顶部连接状态代表 API 身份链路成功，不代表全部后端持续健康。

## M0 尚待完成

1. OpenAPI Bridge 的 execute-as-user 合同与真实负向联调。
2. MCP 新旧协议、Loki tenant scope、OpenObserve Trace 字段的固定版本 Spike；RAGFlow 如采用再验证真实检索。
3. OpenHands 自定义工具、隔离执行与取消机制的独立 Spike。
4. 远程 JWKS 轮转、Operator 认证、逐项目 Provider 集成配置与受审阅工具注册流程。
5. 持久化 Run 的取消/预算/重试耗尽状态、审计可观测性、CI/SBOM 与私密安全报告渠道。

M1 再推进真实知识源 + ModelProvider + Conversation / 人工接管 + Widget。M2 才接真实 runtime / deployment / Git 证据，M3 才接 Sandbox 与人审 PR。
