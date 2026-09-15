# API 与 SDK 参考

对话引导：`POST /api/assistant/route`，SDK 方法 `routeConversation({ message, history, pending })`。消息最多 1000 字符、历史最多六条用户消息；返回下一步候选，不执行业务。具体约束与示例见[对话式助手](../guides/conversation.md)。

Core 在 `/openapi.json` 提供 OpenAPI 3.1 JSON。源码中的 API 定义与请求合同共同维护；集成测试核验路由存在、鉴权和业务行为。运行 `pnpm release:check` 可导出同版本 SDK、OpenAPI 与 SHA-256 清单。

## 身份与请求约定

```http
Authorization: Bearer <short-lived-support-token>
X-Project-Key: your-saas
Content-Type: application/json
Idempotency-Key: <uuid-when-required>
```

使用 HTTPS。项目 key 不是秘密，但必须匹配 Token 的签名声明。Core 根据可信身份建立 organization/project/tenant/subject 数据范围；客户请求不接收任意 scope。未知或无权查看的资源返回 404。

错误形式为 `{"error":{"code":"STABLE_CODE","requestId":"..."}}`。400 表示参数问题，401 表示身份无效，403 表示策略/来源拒绝，404 表示范围内不可见，409 表示冲突或能力尚未配置，429 表示运行预算限制，502/503 表示依赖或执行不可用。

## 功能映射

| HTTP API | SDK | 语义 |
| --- | --- | --- |
| GET /api/session | session() | 身份校验、能力发现 |
| POST /api/knowledge/ask | askKnowledge(query) | 有引用的回答或明确的检索模式 |
| POST /api/knowledge/search | searchKnowledge(query) | 检索当前可见证据 |
| GET /api/knowledge/catalogue | knowledgeCatalogue() | 已发布知识目录 |
| GET /api/knowledge/articles/{id} | knowledgeArticle(id) | 文章与文件行号引用 |
| GET /api/business/queries | listBusinessQueries() | 当前角色允许的业务查询 |
| POST /api/business/query | queryBusiness(id, args) | 当前身份调用固定 GET |
| GET /api/actions | listActions() | 当前角色允许的业务办理 |
| POST /api/actions/plan | planAction(query) | 模型仅生成注册操作预览 |
| POST /api/actions/prepare | prepareAction(id, args) | 准备预览，持久化提案 |
| GET /api/actions/proposals | listActionHistory() | 近期提案与回执 |
| GET /api/actions/proposals/{id} | getAction(id) | 查看单个提案 |
| POST .../{id}/confirm | confirmAction(id) | 确认存储的精确预览 |
| POST .../{id}/reconcile | reconcileAction(id) | 查询回执，不补做写入 |
| POST /api/cases | reportCase(input, key) | 同一事务创建问题、运行和 outbox |
| GET /api/cases | listCases() | 自己的问题 |
| GET /api/cases/{id} | getCase(id) | 详情、执行步骤与当前可见证据 |
| GET /api/cases/{id}/messages | caseMessages(id) | 最近消息 |
| POST /api/cases/{id}/messages | addCaseMessage(id, body, key) | 幂等补充说明 |
| POST /api/cases/{id}/status | setCaseStatus(id, status) | resolved 或 needs_human |
| POST /api/runs/{id}/cancel | cancelRun(id) | 显式取消 |
| POST /api/runs/{id}/retry | retryRun(id, key) | 显式创建受限重试 |

新建 Case 和重试 Run 初次返回 201，重放返回 200。消息发送返回 200 并提供 replayed。重复幂等键只能重放完全相同内容，改变内容返回冲突。提案确认本身用 proposalId 作为唯一执行身份；业务系统仍须把回执与业务写入原子提交。

## 前端入口

```js
import { Agent18, mountFloatingAssistant, mountAssistant, openSupportPage }
  from 'https://support.example.com/sdk/agent18.js';

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
const assistant = mountFloatingAssistant(client, { title: '产品助手' });
// 或 mountAssistant(document.querySelector('#support'), client)
// 独立页在用户点击按钮时调用，保留宿主窗口：
// document.querySelector('#help').onclick = () => openSupportPage(options);
```

每次请求调用 getToken；应用可自行实现短期缓存和刷新，但切换用户后必须销毁旧实例并建立新实例。独立页通过校验 window、精确 Origin、project、channel、requestId 的 postMessage 握手索取短期身份，Token 不出现在 URL、Cookie 或本地持久化中。

浮窗与内嵌面板使用 Shadow DOM。可传 `nonce` 为样式标签配合宿主 CSP；其他站点的全局样式不会污染助手。SDK 只收集调用方明确提供的上下文，pageUrl 会剥离 query/fragment。销毁使用 `assistant.destroy(); client.destroy()`。

## 问题处理约定

客户问题描述和补充说明按纯文本显示。支持回复只允许本地部署者入口发送，客户不能伪造 author。已解决可重新打开；重新打开不自动重跑工具。后台检索完成也不代表客户已确认解决，不能覆盖 resolved 状态。

消息、证据与审计按项目/租户/用户隔离。证据展示时还会检查知识源是否仍然发布：撤下的资料不会因为曾经进入 Case 就继续暴露。

## 运行端点

`/health/live` 用于进程存活；`/health/ready` 检查数据库与已加载的 OPA 默认拒绝策略。`/public/installation` 和 `/public/projects/{key}` 只提供页面与站点身份握手需要的公开信息。

`/internal/*` 使用独立工作负载 Token，不使用客户 Token。`/owner/*` 不存在于 Core，仅存在于本地工作台，必须通过本机 Host/Origin/地址与访问码检查。两者不出现在客户 OpenAPI 中。

## 0.6 合同升级

`CaseDetail.evidence` 现在返回 Evidence envelope，字段见 OpenAPI 的 `Evidence`；旧引用迁移到 `citation`，摘要为 `summary`，版本为 `provenance.sourceVersion`。知识 search/answer 的 `citations` 保持原结构。RunStep 新增 capability、toolId、providerId、inputRef、outputRef、policyDecision，name 保留兼容别名，输入输出引用暂不提供独立读取接口。审计新增 APPROVAL_REQUIRED。SDK `setContext` 接受通用 entity、sessionId、traceId、environment、版本和有界 correlationIds；legacy entityType/entityId 仍接受。
