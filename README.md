# agent18

**让 SaaS 助手回答问题、办理业务、排查故障。**

Open-source support agent for SaaS. **Answer. Act. Investigate.**

[![checks](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml/badge.svg)](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml)
[English](README.en.md) · [使用手册](docs/README.md) · [运行机制综述](docs/overview/agent18-0.8-integration.md) · [贡献指南](CONTRIBUTING.md)

**准备接入已有项目？先读 [接入任务书](INTEGRATE.md)**：明确两个仓库分别改什么，按知识与支持 → 实时查询 → 确认办理推进；附可发给编码助手的任务描述和[目标系统验收报告](docs/reference/integration-acceptance.md)。

agent18 是嵌入现有 SaaS 的开源支持助手。连接已有代码和文档、自己的模型 API 与当前用户身份，客户在一个对话入口中找答案、查数据、确认办理业务；遇到故障，提交页面上下文，后台结合日志与指标协助排查，支持人员接手并沉淀处理经验。

- **回答**：从审核发布的知识中查找带引用的答案，并按当前用户权限查询业务数据。
- **办理**：展示具体变更，经用户确认后调用已登记的业务接口，返回可核对的回执。
- **排查**：收集页面线索，查询 HTTP / Loki / Prometheus；跟进问题、合并巡检异常，形成内部知识草稿。

[//]: # (agent18:release:start)

当前版本：**0.8.0 集成预览**。实现范围见[运行机制综述](docs/overview/agent18-0.8-integration.md)；源码自托管，单机部署。

[//]: # (agent18:release:end)

适合已有登录、业务 API 与知识资料，希望自托管支持能力的 SaaS 团队。业务权限由原系统决定，日志和指标可以继续保存在已有监控平台中。[当前能力与路线图](docs/planning/mvp-roadmap.md)列出可验收范围和剩余工作。

## 从这里运行

需要 Node 24.14.x、pnpm 11.19.0、Docker Compose v2；Git 知识源需要宿主机 Git 读取权限。当前按源码构建，尚未发布官方容器镜像或 npm SDK。以下路径启动包含合成用户与业务数据的本地示例。

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

打开终端显示的 [本地工作台](http://localhost:4321/setup)，输入 Owner access code。依次配置项目身份、模型、知识来源、审核发布与网站入口。安装完成后默认进入运行总览与接入工作台。

[示例 SaaS 与浮动助手](http://localhost:4319/example) · [内嵌助手](http://localhost:4319/example?mode=inline) · [内置文档站点](http://localhost:4318/docs)

没有模型 Key 也可以验证原文索引、引用检索、业务查询、用户确认办理与问题回复。独立支持页从 SaaS 的支持按钮打开，接收当前登录身份。

体验真实运行排查：完成启动后执行 `pnpm observability:demo`，在演示网站点击“模拟业务异常”并通过助手上报，Owner 工作台查看工程证据；再运行 `pnpm test:observability`。参见[监控接入指南](docs/guides/observability.md)。

## 模型提出建议，系统保留授权

**AI reasons. Your system remains in control.**

一次业务写入经过：登记能力与参数校验 → 策略检查 → 具体预览 → 用户确认 → 身份、权限和版本复核 → SaaS 执行 → 回执核对。

模型只能提出已登记的动作和参数。Agent18 携带当前用户的短期身份访问固定接口；SaaS 在执行时再次检查权限，并将业务变更与幂等回执保存在同一事务中。网络结果不确定时，Agent18 查询回执，保持未核实状态直到结果明确。[业务操作协议](docs/guides/business-actions.md)包含具体合同与失败处理。

代码帮助理解业务，业务权限由 SaaS 决定。真实接入需要提供已认证的 Token 签发入口和允许的业务 API，不迁移原有登录、业务数据库或网站架构。

## 当前能交付什么

[//]: # (agent18:capabilities:start)

| 能力 | 状态 | 可用内容 | 接入要求与边界 |
| --- | --- | --- | --- |
| 知识回答 | 已实现 | 目录/Git、原文或模型整理、引用、审核发布与 watch | 来源范围、受众与回答质量需接入方验证 |
| 实时查询 | 已实现 | 已审核的 OpenAPI GET 与只读 POST、当前用户身份、角色和字段投影 | POST 需明确只读审核、参数为平铺基础类型；SaaS 验证对象权限，GraphQL 未适配 |
| 确认办理 | 已实现 | 注册动作、具体预览、明确确认、重新授权、回执核对 | SaaS 实现事务化幂等；无任意网页点击或自主多步写入 |
| 上报与巡检 | 部分实现 | 业务失败事件与页面预览、HTTP/Loki/Prometheus、持久排查、异常合并与恢复 | 需真实数据源和可信标签；完整 Trace 与根因证明尚未实现 |
| 人工接手与经验 | 部分实现 | 持久工单、客户补充、本地工作人员回复、解决/重开、内部知识草稿 | 普通聊天刷新重置；尚无远程客服 SSO、坐席分工或外部工单同步 |
| 开源交付 | 部分实现 | 源码安装、初始化、浮窗/内嵌/独立页、诊断、备份与隔离恢复 | 当前为单机集成预览；官方镜像/npm 包、多实例配额与 HA 尚未交付 |
| 代码修复 | 规划 | 规划：工程证据交接、修复建议、隔离验证与草稿 PR | 当前无自动改代码、合并或生产部署 |

[//]: # (agent18:capabilities:end)

“已实现”表示仓库有可运行实现与验证路径；目标系统的身份、数据、模型质量和线上效果仍按[接入验收报告](docs/reference/integration-acceptance.md)逐项确认。

## 嵌入你的网站

```js
import { Agent18, mountFloatingAssistant }
  from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  capture: { enabled: true, pageText: true, screenshot: false },
  getToken: async () => {
    const response = await fetch('/api/support-token', { method: 'POST' });
    if (!response.ok) throw new Error('请先登录');
    return (await response.json()).token;
  },
});
const assistant = mountFloatingAssistant(client, { title: '产品助手' });
// 页面卸载或用户切换时：assistant.destroy(); client.destroy();
```

也支持 `mountAssistant(container, client)` 与 `openSupportPage(options)`，或仅使用 SDK 自建 UI。示例 `/api/support-token` 由你的 SaaS 后端基于真实会话实现，不能直接信任浏览器传入的用户与租户。

## 接入和运维文档

- [0.8 业务接口与语义上下文](docs/overview/agent18-0.8-integration.md)、[宿主业务失败事件](docs/guides/semantic-context.md)：适配现有 POST 查询，让失败报告关联具体业务操作。

- [已有项目接入任务书](INTEGRATE.md)、[接入验收报告模板](docs/reference/integration-acceptance.md)：从仓库 URL 到真实网站效果，记录实际通过与未接入项。
- [0.7 全场景机制](docs/overview/agent18-0.7-operations.md)、[页面采集与监控接入](docs/guides/observability.md)。
- [0.6 核心抽象审查与升级](docs/overview/agent18-0.6-core.md)、[Provider / Tool 注册规范](docs/reference/providers.md)。

- [安装与公开部署](docs/guides/installation.md)：本地启动、初始化、HTTPS、演示与正式部署分开。
- [网站与身份](docs/guides/integration.md)：Support Token、公钥、租户、CORS、三种前端入口。
- [知识构建与更新](docs/guides/knowledge.md)：源码/文档、模型、范围、版本、发布和 watch。
- [OpenAPI 查询](docs/guides/business-queries.md)、[业务操作协议](docs/guides/business-actions.md)：用户身份下的真实业务调用。
- [诊断、备份与恢复](docs/guides/operations.md)：从检查失败到独立新库恢复和切换。
- [API 与 SDK](docs/reference/api.md)、[配置参考](docs/reference/configuration.md)、[技术标准与边界](docs/reference/standards.md)。
- [公开路线图](docs/planning/mvp-roadmap.md)、[评审核验与研发优先级](docs/planning/review-and-priorities.md)：当前缺口、下一轮交付与验收条件。

## 开发与验收

```sh
pnpm check
pnpm test:policy
pnpm test:integration
pnpm test:recovery
pnpm test:journey
pnpm run doctor
pnpm backup
```

集成与恢复测试使用本地合成数据，部分会暂停/恢复本项目服务；不要直接指向正式实例。`test:journey` 从新配置、新数据库和独立 Compose 项目开始验证完整路径。结束后只清理它自己创建的资源。

`release:check` 在 `.local/release` 生成 SDK、OpenAPI、许可证和 SHA-256 清单。当前通过源码自托管，不依赖已经发布的公共 npm 包或镜像。

## 仓库结构

```text
apps/console, server, worker   客户入口、Core API、持久化任务
apps/setup                    本机初始化和部署工作台
packages/knowledge            扫描、索引、模型整理、版本发布和检索
packages/actions              OpenAPI 查询、动作注册、确认与回执
packages/application          Case / Run、消息、状态、工具编排与持久观测
providers/observability       HTTP / Loki / Prometheus 只读工程证据
packages/policy, persistence   OPA、迁移、RLS、审计和 outbox
packages/web-sdk              无框架 SDK 与可选 Shadow DOM 助手
examples/identity-bridge       独立 SaaS 身份、OpenAPI、业务数据库和桥接示例
scripts                       配置、构建、诊断、恢复与安装旅程
```

Core 使用 Apache-2.0，Web SDK 使用 MIT。许可证不改变客户业务 API 和知识来源的权限。[安全策略](SECURITY.md)描述已实现边界和剩余部署责任。
