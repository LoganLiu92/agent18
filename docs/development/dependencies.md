# 固定依赖与分发范围

2026-09-14：应用依赖精确版本见根目录及各 workspace 的 `package.json`，传递依赖和完整性记录在 `pnpm-lock.yaml`。pnpm 11.19.0，Node 24.14.0。

| 组件 | 本地使用版本 | 用途 |
|---|---|---|
| Fastify | 5.12.4 | HTTP Server / demo issuer |
| jose | 6.2.12 | EdDSA JWT、受信配置中的公钥集 |
| pg / pg-boss | 8.23.0 / 12.31.1 | scoped transactions / durable jobs |
| React / Vite | 19.3.0 / 8.3.0 | 客户演示界面 |
| TypeScript / Vitest | 7.0.2 / 5.0.0 | 类型检查与测试 |
| Zod | 4.6.5 | 静态注册的请求与 Provider 输出 Schema |

Compose 的 Node、PostgreSQL 17 和 OPA 1.20.2 已固定镜像 digest，见 `deploy/compose/compose.yaml` 与 Dockerfile。固定版本用于复现，不代表已完成发布安全审核。

Core 按架构建议采用 Apache-2.0；`packages/web-sdk` 采用 MIT。上述依赖保留各自许可证，第三方许可证文件保留于包/镜像中。外部 RAGFlow、OpenObserve、Loki、OpenHands、MCP 尚未打包或运行，不应把[选型评估](../research/component-evaluation.md)误读为已分发组件清单。

本地安装遇到 pnpm 11 的构建脚本许可配置变更，使用 `allowBuilds.esbuild: true` 明确允许 esbuild 安装脚本。两个当日发布的固定依赖在 `minimumReleaseAgeExclude` 中逐项列出；没有关闭全部依赖的发布年龄检查。

实现依据：[Fastify Validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[jose](https://github.com/panva/jose)、[OPA Rego](https://www.openpolicyagent.org/docs/policy-language)、[pg-boss](https://pgboss.io/)。实际队列 API 和迁移行为以安装后的 12.31.1 源码、类型定义和本地集成测试为准。
