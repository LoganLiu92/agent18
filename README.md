# agent18

**让 SaaS 的 AI 客服，不止回答问题。**

查业务、确认办理、协助排查，把客户的问题接着处理下去。

[![checks](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml/badge.svg)](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml)
[English](README.en.md) · [快速开始](#快速开始) · [接入指南](#接入已有-saas) · [使用手册](docs/README.md)

agent18 是嵌入现有 SaaS 的开源 AI 支持助手。它连接产品文档与代码、当前用户身份、业务 API 和运行监控，让客户在一个对话入口中找答案、查数据、确认操作、提交问题。

**Answer · 有出处的回答。** 从审核发布的知识中回答产品问题；需要实时状态时，调用当前用户有权访问的业务接口。

**Act · 先确认，再办理。** 展示具体变更，等待用户确认，由 SaaS 校验权限并执行，最后核对业务回执。

**Investigate · 带着线索处理问题。** 上报前预览页面上下文，结合日志与指标协助排查，交由支持人员跟进；处理经验可整理为待审核的知识草稿。

适合已有登录、业务 API 和产品资料，希望自托管支持能力的 SaaS 团队。**不需要迁移原有登录或业务数据库，也不把管理员权限交给模型。**

[//]: # (agent18:release:start)

当前版本：**0.8.0 集成预览**。实现范围见[运行机制综述](docs/overview/agent18-0.8-integration.md)；源码自托管，单机部署。

[//]: # (agent18:release:end)

## 快速开始

准备 **Node.js 24.14.x、pnpm 11.19.0、Docker Compose v2 和 Git**。以下命令从源码构建，启动带合成用户与业务数据的本地演示；不是公开生产部署命令。

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

打开 [本地工作台](http://localhost:4321/setup)，输入终端显示的 **Owner access code**。先选择演示系统，再按向导配置知识来源、构建并审核发布，选择网站入口。

日常知识管理和工单处理使用独立[员工后台](http://localhost:4318/admin)。首位管理员在 Setup 中创建，再按项目和租户授权；Owner access code 仅用于本机部署维护。

**模型 Key 可选。** 不配置模型，也能体验原文检索与引用、业务查询、确认办理和问题跟进；模型生成与模型辅助回答需要另行配置，确定性演示不代表真实模型效果。

打开 [示例 SaaS 与浮动助手](http://localhost:4319/example)，试一遍：

| 输入或操作 | 应该看到什么 |
| --- | --- |
| `查询我的订单` | 查询当前用户的业务数据；切换演示用户后，结果遵守对应用户权限。 |
| `关闭邮件通知` | 先展示具体预览，确认后执行；再输入 `查看我的通知偏好` 核对实际状态。 |
| `提交问题` | 预览并选择是否附带页面上下文，提交后补充说明、查看支持回复与进展。 |

知识问答可从刚发布的文档中选一个问题，检查回答或检索结果是否带有来源引用。

也可体验 [内嵌助手](http://localhost:4319/example?mode=inline)；独立支持页从示例 SaaS 的支持按钮打开。内置手册位于 [本地文档站点](http://localhost:4318/docs)。

### 再试一次故障排查

保留默认 `invoice-demo` 的本地演示环境中，另开终端执行：

```sh
pnpm observability:demo
```

在示例 SaaS 点击“模拟业务异常”，通过助手上报，再到本地工作台查看关联日志、指标与排查报告。该演示使用真实 Loki / Prometheus 组件和合成故障数据，**排查分析不是已证明的根因**。配置与验证见[监控接入指南](docs/guides/observability.md)。

停止演示使用 `pnpm demo:stop`；仅关闭工作台终端不会停止 Docker 服务。遇到问题先运行 `pnpm run doctor`，再查[安装指南](docs/guides/installation.md)。

## AI 提出建议，业务系统掌握权限

业务写入不是“模型选一个工具就直接执行”，而是：

```text
已登记的动作 → 参数与策略检查 → 具体预览 → 用户明确确认
            → 重新校验身份、权限与业务版本 → SaaS 执行 → 回执核对
```

agent18 使用当前用户的短期身份调用固定业务接口。**最终授权、对象归属和业务规则由你的 SaaS 校验**；SaaS 还需将业务变更与幂等回执保存在同一事务中。网络结果不确定时核对回执，不把超时当作成功，也不盲目重发写入。

代码和文档帮助理解业务，不能授予业务权限。模型不能注册任意接口，也不能执行任意 SQL、Shell 或网页点击。完整约定见[业务操作协议](docs/guides/business-actions.md)。

## 接入已有 SaaS

从[接入任务书](INTEGRATE.md)开始，按需逐步接通，不必一次接完所有能力。

交给另一个项目的编码助手时，可直接复制任务书末尾的[接入提示词](INTEGRATE.md#可以发给另一个项目的任务描述)，并要求交付[实际验收报告](docs/reference/integration-acceptance.md)。

| 接入内容 | 你的系统需要提供什么 |
| --- | --- |
| 身份与网站入口 | 后端根据真实登录会话签发 Support Token；配置项目、租户、公钥和允许的网站 Origin，前端挂载 SDK。 |
| 产品知识 | 可读取的文档或代码、明确的客户/内部受众，构建后审核发布。 |
| 查询与办理 | 审核后的只读 API；办理业务时另行实现 `prepare / execute / status` 业务桥及事务化回执。 |
| 排查与人工跟进 | 按需接入 HTTP / Loki / Prometheus / Tempo、可信范围标签和只读凭据；为工作人员分配项目与租户权限。 |

查询支持从 OpenAPI 导入受限 **GET** 候选；只读 **POST** 需单独登记和审核，不会自动导入。详见[业务查询指南](docs/guides/business-queries.md)。

### 最小前端接入

先完成[身份签发与 Origin / CSP 配置](docs/guides/integration.md)，再在已登录页面的 ES module 中挂载：

```js
import { Agent18, mountFloatingAssistant }
  from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  capture: { enabled: true, pageText: true, screenshot: false },
  getToken: async () => {
    const response = await fetch('/api/support-token', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('无法获取支持身份，请检查登录状态');
    const { token } = await response.json();
    if (typeof token !== 'string' || !token) throw new Error('支持身份接口未返回 Token');
    return token;
  },
});

const assistant = mountFloatingAssistant(client, { title: '产品助手' });

// 退出登录、切换用户/租户或卸载页面时，由宿主调用：
function disconnectSupport() {
  assistant.destroy();
  client.destroy();
}
```

示例域名、项目标识需替换。`/api/support-token` 由你的后端实现，并使用现有会话与 CSRF 防护；不要信任浏览器提交的用户、租户或角色。敏感页面区域标记 `data-agent18-private`，上线前核验采集预览。

也支持 `mountAssistant(container, client)`、`openSupportPage(options)`，或仅使用 SDK 自建 UI。业务成功后刷新宿主数据的回调、身份切换与独立页交接，见[完整接入示例](docs/guides/integration.md)。

## 版本与能力

下面区分可运行实现、部分实现和规划，不把接入完成或生产可用当作默认前提。

**主分支与现有部署不是一回事。** 当前源码中的独立员工后台、持久对话、工单分配、知识维护和业务分析，需要对应迁移、配置及权限授权；拉取文档不会自动升级正在运行的服务。使用步骤与边界见[正式后台指南](docs/guides/support-workspace.md)，开发记录见[第十七轮](docs/development/round17-product-workflows.md)。

[//]: # (agent18:capabilities:start)

| 能力 | 状态 | 可用内容 | 接入要求与边界 |
| --- | --- | --- | --- |
| 知识回答 | 已实现 | 目录/Git、原文或模型整理、引用、审核发布与 watch | 来源范围、受众与回答质量需接入方验证 |
| 实时查询 | 已实现 | 已审核的 OpenAPI GET 与只读 POST、当前用户身份、角色和字段投影 | POST 需明确只读审核、参数为平铺基础类型；SaaS 验证对象权限，GraphQL 未适配 |
| 确认办理 | 已实现 | 注册动作、具体预览、明确确认、重新授权、回执核对 | SaaS 实现事务化幂等；无任意网页点击或自主多步写入 |
| 上报与巡检 | 部分实现 | 业务失败事件与页面预览、HTTP/Loki/Prometheus/Tempo、持久排查、异常合并与恢复、可信部署记录 | 需真实数据源与可信范围标签；Trace 缺失或范围不符返回未知或拒绝；关联证据不等于根因证明 |
| 人工接手与经验 | 部分实现 | 持久对话、工单分配、客户补充、工作人员回复、解决/重开与内部知识草稿 | 需对应源码迁移与员工租户授权；恢复已保存文本与历史引用，不重放业务操作；外部工单需实际适配与验收 |
| 开源交付 | 部分实现 | 源码安装、初始化、浮窗/内嵌/独立页、诊断、备份与隔离恢复 | 当前为单机集成预览；官方镜像/npm 包、多实例配额与 HA 尚未交付 |
| 代码修复 | 规划 | 规划：工程证据交接、修复建议、隔离验证与草稿 PR | 当前无自动改代码、合并或生产部署 |

[//]: # (agent18:capabilities:end)

“已实现”表示仓库提供实现与验证路径，不代表已在你的业务上验收。接入时按[目标系统验收报告](docs/reference/integration-acceptance.md)验证真实身份、跨用户/租户隔离、模型效果、业务写入和故障路径。

## 文档与开发

| 你要做什么 | 文档入口 |
| --- | --- |
| 运行、部署与维护 | [安装](docs/guides/installation.md) · [运维与恢复](docs/guides/operations.md) · [安全策略](SECURITY.md) |
| 接入现有产品 | [接入任务书](INTEGRATE.md) · [身份与 SDK](docs/guides/integration.md) · [接入验收](docs/reference/integration-acceptance.md) |
| 管理知识与支持 | [知识构建](docs/guides/knowledge.md) · [员工后台](docs/guides/support-workspace.md) · [知识治理与业务分析](docs/guides/advanced-workflows.md) · [监控接入](docs/guides/observability.md) |
| 理解实现与扩展 | [运行机制](docs/overview/agent18-0.8-integration.md) · [API 与 SDK](docs/reference/api.md) · [手册目录](docs/README.md) |
| 参与开发 | [贡献指南](CONTRIBUTING.md) · [路线图](docs/planning/mvp-roadmap.md) · [变更记录](CHANGELOG.md) |

```sh
pnpm check          # 格式、文档、构建、测试与本地交付检查
pnpm run doctor     # 已配置本地实例的运行诊断
```

数据库、恢复和完整旅程测试按[贡献指南](CONTRIBUTING.md)选择独立环境运行；部分测试会暂停演示服务或修改演示数据，不要指向正式实例。

版本与能力表由 `docs/release.json` 管理。修改清单后执行 `pnpm docs:sync`，再运行 `pnpm docs:check`；保留 README 中的生成标记。

## 许可证

Core 使用 [Apache-2.0](LICENSE)，Web SDK 使用 [MIT](packages/web-sdk/LICENSE)。知识来源和业务 API 的访问权限由各自系统管理。
