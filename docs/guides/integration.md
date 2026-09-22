# 接入现有 SaaS 网站

agent18 不替换业务系统登录。SaaS 后端在确认当前会话后签发短期 Support Token；agent18 校验签名、固定 issuer/audience、项目、租户和用户。前端只持有短期 Token，模型 Key、索引库和业务管理凭据留在部署端。

完整接入顺序与预期效果见[已有项目接入任务书](../../INTEGRATE.md)，本页说明身份和前端的具体合同。

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
# 重新创建 Core，加载项目配置（普通 restart 不足以更新单文件挂载）

docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml up -d --no-deps --force-recreate --wait server
```

该命令使用一次性迁移凭据写入项目/租户元数据，更新本地与 Docker Core 配置，拒绝覆盖既有项目的身份映射，拒绝 JWK 私钥字段。重复执行只更新元数据，不删除既有租户或业务数据。数据库事务和配置文件写入不构成跨资源事务；若文件写入失败，修正权限后重新执行同一命令。

当前只实现静态公钥集；轮换时先加入新公钥、重新创建 Core，再切换签发 key，待旧 Token 过期后移除旧公钥并再次应用配置。未实现远程 JWKS 自动轮换、即时撤销 Token 或完整租户管理后台。

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

站点 Origin 必须精确匹配项目配置，包括协议、域名和端口，无尾斜杠，不支持 `*`。跨域请求使用 Bearer Token，不传 Cookie。宿主 CSP 应允许加载 SDK 并连接 Core；内置面板通过 Shadow DOM 隔离样式，可传 nonce 为样式标签匹配宿主 CSP，也可只使用 SDK 构建自身 UI。

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

不要在模型规划结束后自动调用 `confirmAction`。前端切换登录用户或租户时销毁旧面板和 SDK 实例、清除旧页面状态，并用新身份重新创建。SDK 接收页面路径、通用实体、traceId/sessionId、环境与版本等显式线索；另在问题上报预览时准备有界页面文字/错误及可选截图，不读取 Cookie 或网络正文。参见[页面采集](observability.md)；任何页面内容都不是可信授权依据。

浮窗与内嵌面板使用一个消息流和输入框，持续引导知识问答、业务参数补充、预览确认、回执以及问题提交、进展和回复。独立支持页提供目录与工作区，也可用 SDK 自建界面。业务示例和注册方法见[业务操作指南](business-actions.md)。


## 网站中的三种界面入口

部署者可以先运行 `pnpm setup:ui`，在向导中登记项目、公钥和网站 Origin，然后取得对应接入代码。详见 [安装指南](installation.md)。

```js
import {
  Agent18, mountFloatingAssistant, mountAssistant, openSupportPage,
} from 'https://support.example.com/sdk/agent18.js';

const options = {
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  getToken: async () => {
    const response = await fetch('/api/support-token', { method: 'POST' });
    if (!response.ok) throw new Error('请先登录');
    return (await response.json()).token;
  },
};
const client = new Agent18(options);
const pages = new Set();
const openPage = () => {
  try { pages.add(openSupportPage(options)); }
  catch { /* 提示用户允许弹窗，或继续使用浮窗。 */ }
};
const assistant = mountFloatingAssistant(client, {
  title: '产品助手',
  position: 'right', // 也可使用 left
  onOpenPage: openPage,
  onActionComplete: (proposal) => {
    // 已收到 succeeded 回执；由宿主自己的代码刷新对应业务数据。
    console.info('业务已完成', proposal.id);
  },
});
document.querySelector('#help').onclick = openPage;
// 内嵌时改为：mountAssistant(document.querySelector('#support'), client)

function disconnectSupport() {
  assistant.destroy();
  client.destroy();
  for (const page of pages) page.destroy();
  pages.clear();
}
// 路由卸载、退出登录和切换用户时由宿主调用 disconnectSupport()。
```

浮窗与嵌入区块使用 Shadow DOM 隔离样式，远端文本通过文本节点呈现。宿主有严格样式 CSP 时，可传 `nonce` 为 SDK 的样式元素设置 CSP nonce；SDK 不放宽站点 CSP。使用脚本 URL 的 Origin 需加入宿主 `script-src`，Core API Origin 需加入 `connect-src`。

`openSupportPage` 必须由点击等浏览器用户手势调用。它打开 `/support` 并建立到原页面的短期身份交接：父/子窗口校验窗口引用、精确 Origin、随机 channel、project 与 requestId；URL 不携带 Token。子页每轮 API 请求向原 SaaS 获取当前身份，并发请求可合并，Token 不写入 localStorage/sessionStorage。原页面关闭、身份提供失败或连接销毁时，支持页不能继续取得新 Token。宿主主动销毁连接不会强制关闭客户的支持页。

若宿主设置了会隔离跨源 opener 的 COOP 策略、浏览器禁用弹窗，或业务站点 Origin 未登记，独立页无法完成交接；可继续使用同页浮窗/嵌入模式，或由接入方实现适合自己 SSO 的专用入口。不要通过 URL 参数传长期凭据。

## 业务操作经过谁

前端调用的是 agent18 API。最终写业务数据的是 **SaaS 后端**：agent18 Core 在用户确认后，携带 Support Token 调用已注册业务桥，SaaS 再核验用户、对象权限和业务条件。前端成功回调用于刷新显示，不承担权限判断；没有自动点击原网页或读取其 DOM 的执行器。参见 [业务桥协议](business-actions.md)。


## 接入工作台

初始化完成后，本地工作台默认进入运行总览。系统与能力页面可以维护现有项目的 Issuer/Audience/公开 JWKS、精确站点 Origin、租户登记，导入 OpenAPI 查询并配置业务操作。租户编辑是新增/更新，不会删除已存在数据。

注册业务能力见[OpenAPI 查询](business-queries.md)与[代操作协议](business-actions.md)。先保存配置，再“应用到运行服务”，最后从 SaaS 当前用户测试；Core 成功重启不等于 SaaS 业务权限已经验证。

客户页面和 SDK 支持持久对话、问题消息、处理进展、解决与重开。日常支持使用独立员工账号进入 `/admin`，先获得项目角色与明确租户范围，再分配和回复工单；本地 Setup 保留部署者维护入口。客户只能读自己范围内的公开回复，内部备注和工程证据分开授权。见[员工后台](support-workspace.md)和[API 与 SDK](../reference/api.md)。
