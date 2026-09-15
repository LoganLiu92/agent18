# 接入现有 SaaS 网站

agent18 不替换业务系统登录。SaaS 后端在确认当前会话后签发短期 Support Token；agent18 校验签名、固定 issuer/audience、项目、租户和用户。前端只持有短期 Token，模型 Key、索引库和业务管理凭据留在部署端。

## 1. 部署基础服务

按 README 启动 PostgreSQL、OPA、Core 与 Worker。生产部署应在 HTTPS 反向代理后发布 Core，使用自己的域名和数据库备份/密钥管理。示例 Compose 只绑定回环地址，属于本地开发部署。Core 需要访问所配置的模型与业务桥；Worker 无需访问它们。

正式接入时停用 `identity-demo`，也不要使用 Console 的固定演示身份选择器。产品前端可以嵌入 SDK 面板或自建 UI。独立业务桥应部署在 SaaS 信任域中。

## 2. 注册项目、公钥和租户

创建 `.local/your-project.json`。下面的 UUID 为示例；实际项目使用独立 UUID，`x`/`kid` 替换为自己 Ed25519 公钥的 JWK 字段。

```json
{
  "organizationName": "Your company",
  "projectName": "Your SaaS",
  "project": {
    "key": "your-saas",
    "organizationId": "30000000-0000-4000-8000-000000000018",
    "projectId": "40000000-0000-4000-8000-000000000018",
    "issuer": "https://your-saas.example",
    "audience": "agent18:support",
    "jwks": {"keys": [{"kty":"OKP","crv":"Ed25519","x":"YOUR_PUBLIC_KEY_BASE64URL","kid":"support-1","alg":"EdDSA","use":"sig"}]},
    "knowledge": "indexed",
    "allowedOrigins": ["https://your-saas.example"]
  },
  "tenants": [{"id":"tenant-001","name":"Example customer"}]
}
```

```sh
pnpm project:configure .local/your-project.json
# 重启 Core，加载项目配置

docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml restart server
```

该命令使用一次性迁移凭据写入项目/租户元数据，更新本地与 Docker Core 配置，拒绝覆盖既有项目的身份映射，拒绝 JWK 私钥字段。重复执行只更新元数据，不删除既有租户或业务数据。数据库事务和配置文件写入不构成跨资源事务；若文件写入失败，修正权限后重新执行同一命令。

当前只实现静态公钥集；轮换时先加入新公钥、重启 Core，再切换签发 key，待旧 Token 过期后移除旧公钥。未实现远程 JWKS 自动轮换、即时撤销 Token 或完整租户管理后台。

## 3. SaaS 后端签发 Token

`POST /api/support-token` 必须使用 SaaS 自己的登录会话与 CSRF 防护。租户、用户、角色应从服务端会话推导，禁止直接信任浏览器提交的同名字段。

以下是 Node/jose 核心逻辑示例；会话读取由现有系统实现：

```ts
import { SignJWT } from 'jose';
// privateKey 来自 SaaS 密钥管理；不要放进网页、agent18 Core 或仓库。
async function issueSupportToken(authenticatedSession, privateKey) {
  return new SignJWT({
    kind: 'customer',
    project_key: 'your-saas',
    tenant_id: authenticatedSession.tenantId,
    roles: authenticatedSession.roles,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'support-1' })
    .setSubject(authenticatedSession.userId)
    .setIssuer('https://your-saas.example')
    .setAudience('agent18:support')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
```

Token 最长有效期 10 分钟，建议 5 分钟。SDK 每次调用 `getToken`，宿主可缓存并在到期前刷新。业务确认时由业务桥重新验证 Token 和业务对象权限；即使 Token 中角色尚未过期，SaaS 也应查询当前权限与资源状态。

## 4. 前端接入

参考 README 中 `Agent18` 与 `mountAssistant` 示例。Core 从 `/sdk/agent18.js` 提供构建后的 ES Module；也可把 `packages/web-sdk/dist/agent18.js` 放入自己的静态资源部署，不需要公共 npm 包。

站点 Origin 必须精确匹配项目配置，包括协议、域名和端口，无尾斜杠，不支持 `*`。跨域请求使用 Bearer Token，不传 Cookie。宿主 CSP 应允许加载 SDK 并连接 Core；内置面板使用少量元素内联样式，若宿主禁止该样式，可只使用 SDK 并实现符合自身设计规范的 UI。

```ts
await client.knowledgeCatalogue();
await client.knowledgeArticle(articleId);
await client.askKnowledge('如何创建订单？');
await client.reportCase({title:'订单提交异常',description:'操作步骤与可公开的错误信息'}, crypto.randomUUID());
await client.listActions();
const preview = await client.prepareAction('order.note.update', {orderId:'current-order-id',note:'补充备注'});
// 展示 preview 后，在明确的用户确认事件中调用：
await client.confirmAction(preview.id);
// 结果未确认时，只查询回执：
await client.reconcileAction(preview.id);
```

不要在模型规划结束后自动调用 `confirmAction`。前端切换登录用户或租户时销毁旧面板和 SDK 实例、清除旧页面状态，并用新身份重新创建。SDK 的上下文只采集显式传入的路径和实体 ID，不读取 Cookie、DOM 或网络响应。

内置面板包含知识问答、可用业务操作表单、模型生成操作预览和确认/回执。完整问题列表、Run 历史等可通过 SDK 自行组合，演示 Console 已展示这些能力。业务示例和注册方法见[业务操作指南](business-actions.md)。
