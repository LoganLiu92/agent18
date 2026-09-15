# agent18

**Turn your SaaS code and documentation into an embedded, evidence-based assistant.**

agent18 为现有 SaaS 提供知识库、客户支持和业务操作助手。配置代码仓库与文档，使用自己的模型 API，接入网站身份与业务接口，让用户在原网站中找到答案、提交问题，并以自己的身份完成业务操作。

**当前版本：0.3.0 开发预览。** 已有可运行的源码/文档知识构建、按版本发布、带引用检索与模型问答、用户确认的业务操作、持久化支持任务、权限隔离与网站 SDK。真实业务的身份校验和操作接口仍需要 SaaS 接入；日志调查、自动修复代码和 PR 尚未实现。

[整体机制与实现综述](docs/overview/agent18-0.3-mechanism.md) · [知识库配置](docs/guides/knowledge.md) · [网站与身份接入](docs/guides/integration.md) · [业务操作接口](docs/guides/business-actions.md)

## 本地运行

需要 Node 24.14.x、pnpm 11.19.0、Docker Compose。Git 知识源另需宿主机 Git 和对应只读访问权限。

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm demo:start
```

打开 [localhost:4318](http://localhost:4318)。默认只绑定回环地址。演示身份签发器用于本地合成数据；现有 SaaS 使用自己的已认证后端签发短期 Token。

## 从现有代码和文档建立知识库

```sh
pnpm knowledge init
# 编辑 .local/knowledge.json：配置本地目录或 Git 仓库、文件范围、受众
pnpm knowledge sync
pnpm knowledge status
pnpm knowledge export <build-id> > .local/review.json
pnpm knowledge publish <build-id>
pnpm knowledge enable
# 重启 Core 应用配置，不影响数据卷

docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml restart server
```

`init` 默认配置本项目文档作为客户资料、源码作为内部资料。每个知识源独立构建、发布；默认新增源受众为 `internal`。代码无需执行，Git 来源固定到 commit，文章保留文件/行号引用。失败不替换已发布快照。

无模型时可用原文索引；配置 `.local/model.env`，把知识配置中的 `mode` 改为 `model`，即可让模型自动整理结构化知识条目，网站也可提供带引用回答与业务操作规划。模型 Key 只在部署端使用，详见[配置指南](docs/guides/knowledge.md)。

## 试用业务助手

```sh
pnpm demo:actions
pnpm demo:start
```

也可以打开独立的[示例 SaaS 嵌入页面](http://localhost:4319/example)，验证从原有网站加载 SDK 和跨域身份调用。

在“业务助手”选择“修改我的通知偏好”，生成预览、确认执行、查看回执。业务示例由独立 SaaS 服务校验用户并持久化到自己的 SQLite 数据库；它只保存偏好，不发送邮件。执行超时进入“结果待确认”，查询回执时不会重发写操作。

## 嵌入网站

```js
import { Agent18, mountAssistant } from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  getToken: async () => {
    const response = await fetch('/api/support-token', { method: 'POST' });
    if (!response.ok) throw new Error('登录已失效');
    return (await response.json()).token;
  },
});
client.setContext({ pageUrl: location.href, entityType: 'order', entityId: 'current-order-id' });
const assistant = mountAssistant(document.querySelector('#support-assistant'), client);
// 离开页面或切换登录身份：assistant.destroy(); client.destroy();
```

先按[接入指南](docs/guides/integration.md)注册项目、公钥、租户与站点 Origin。可以使用内置面板，也可以只使用 SDK 构建自己的 UI。SDK 不收集 Cookie、DOM、完整 URL 或网络请求内容。

## 开发与验证

```sh
pnpm build
pnpm test
pnpm test:policy
pnpm test:integration  # 使用本地合成数据；生命周期测试会暂停并恢复本项目 Worker
pnpm test:recovery     # 会暂停并恢复本项目 Server/Worker
pnpm logs
pnpm demo:stop         # 保留数据卷与 .local 配置
```

`.github/workflows/ci.yml` 定义上述检查；远程 CI 是否通过以 GitHub 的实际运行结果为准。

```text
apps/console, server, worker     客户工作台、HTTP API、持久化任务
packages/knowledge              扫描、分块、模型整理、增量缓存、发布与检索
packages/actions                业务注册表、预览、确认、回执核对
packages/application, policy    Case / Run 编排、工具网关与 OPA
packages/persistence            PostgreSQL migration 与 RLS
packages/web-sdk                无框架 SDK 与可选嵌入面板
examples/identity-bridge        独立本地 SaaS 身份及业务接口示例
scripts                        部署配置、知识构建、项目注册与验证
```

历史记录：[0.2 运行综述](docs/overview/agent18-overview-20260915.md)（[历史 Word 版](docs/overview/agent18-运行机制与实现综述-20260915.docx)）、[组件评估](docs/research/component-evaluation.md)。当前能力以 0.3 文档与测试为准。

[贡献说明](CONTRIBUTING.md) · [安全边界](SECURITY.md) · [GitHub](https://github.com/LoganLiu92/agent18)

Core 使用 [Apache-2.0](LICENSE)，Web SDK 使用 [MIT](packages/web-sdk/LICENSE)。尚未发布 npm 包或公共容器镜像。
