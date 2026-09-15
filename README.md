# agent18

**An open-source assistant that connects your SaaS knowledge, users and business APIs.**

[![checks](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml/badge.svg)](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml)
[English](README.en.md) · [使用手册](docs/README.md) · [运行机制综述](docs/overview/agent18-0.5-overview.md) · [贡献指南](CONTRIBUTING.md)

agent18 为现有 SaaS 提供一套可自行部署、配置和嵌入的支持与业务助手。连接已有代码和文档，使用自己的模型 API，沿用用户身份，让客户在原网站找答案、查业务、经确认办理业务，并持续跟进尚未解决的问题。

**0.5.0 集成预览版**，覆盖知识、身份、业务接口与支持闭环。提供初始化向导、部署工作台、网站浮窗/内嵌/独立页、API 文档、诊断与备份恢复工具。运行时日志调查和自动代码修复仍为后续扩展。

## 从这里运行

需要 Node 24.14.x、pnpm 11.19.0、Docker Compose v2；Git 知识源需要宿主机 Git 读取权限。

```sh
git clone git@github.com:LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

打开终端显示的 [本地工作台](http://localhost:4321/setup)，输入 Owner access code。依次配置项目身份、模型、知识来源、审核发布与网站入口。安装完成后默认进入运行总览与接入工作台。

[示例 SaaS 与浮动助手](http://localhost:4319/example) · [内嵌助手](http://localhost:4319/example?mode=inline) · [内置文档站点](http://localhost:4318/docs)

没有模型 Key 也可以验证原文索引、引用检索、业务查询、用户确认办理与问题回复。独立支持页从 SaaS 的支持按钮打开，接收当前登录身份。

## 一套接入，完整使用路径

| 能力 | 实际行为 |
| --- | --- |
| 自有知识体系 | 目录/Git → 版本快照 → 原文或模型整理 → 文件行号引用 → 审核发布；watch 持续发现变化 |
| 当前用户身份 | SaaS 签发短期 Token，Core 校验项目/租户/用户，数据库 FORCE RLS，精确网站 Origin |
| 业务查询 | 导入 OpenAPI GET 候选，审核角色与字段，调用当前用户的 SaaS API，返回实时数据 |
| 代客操作 | 注册动作 → 具体预览 → 用户确认 → 后端执行 → 幂等回执；超时保持不确定并核对 |
| 客户问题闭环 | 提交与持久化调查 → 查看证据 → 补充说明 → 支持人员回复 → 解决或重新打开 |
| 接入与运行管理 | 向导、工作台、版本/健康诊断、备份、隔离恢复、公开部署配置、随版本 API 文档 |

代码帮助理解业务，业务权限由 SaaS 决定。真实接入需要提供已认证的 Token 签发入口和允许的业务 API，不迁移原有登录、业务数据库或网站架构。

## 嵌入你的网站

```js
import { Agent18, mountFloatingAssistant }
  from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
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

- [安装与公开部署](docs/guides/installation.md)：本地启动、初始化、HTTPS、演示与正式部署分开。
- [网站与身份](docs/guides/integration.md)：Support Token、公钥、租户、CORS、三种前端入口。
- [知识构建与更新](docs/guides/knowledge.md)：源码/文档、模型、范围、版本、发布和 watch。
- [OpenAPI 查询](docs/guides/business-queries.md)、[业务操作协议](docs/guides/business-actions.md)：用户身份下的真实业务调用。
- [诊断、备份与恢复](docs/guides/operations.md)：从检查失败到独立新库恢复和切换。
- [API 与 SDK](docs/reference/api.md)、[配置参考](docs/reference/configuration.md)、[技术标准与边界](docs/reference/standards.md)。

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
packages/application          Case / Run、消息、状态、工具编排
packages/policy, persistence   OPA、迁移、RLS、审计和 outbox
packages/web-sdk              无框架 SDK 与可选 Shadow DOM 助手
examples/identity-bridge       独立 SaaS 身份、OpenAPI、业务数据库和桥接示例
scripts                       配置、构建、诊断、恢复与安装旅程
```

Core 使用 Apache-2.0，Web SDK 使用 MIT。许可证不改变客户业务 API 和知识来源的权限。[安全策略](SECURITY.md)描述已实现边界和剩余部署责任。
