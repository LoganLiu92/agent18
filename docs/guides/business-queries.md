# OpenAPI 业务查询

业务查询用于回答“我的订单处理到哪了”“刚才的设置是否保存”等问题。知识回答解释产品规则，业务查询读取业务系统当前状态；界面明确展示数据来源与查询时间。

## 查询执行机制

1. 部署者把 SaaS 的 OpenAPI JSON 导入本地工作台。导入过程不访问文档中的 servers 地址，不读取外部引用。
2. 解析器产生 GET 候选，默认关闭。部署者选择开放的操作、用户角色和返回字段，配置固定 API 基础地址，再保存并应用。
3. 客户选择查询并填写业务参数。Core 验证当前短期 Token、项目、租户、角色、操作启用状态、参数范围与 OPA 决策，提交审计后才调用后端。
4. Core 使用当前请求的 Bearer Token 发起 GET。SaaS 再次校验身份和对象权限，按真实业务授权返回数据。
5. Core 只投影批准的字段，最多 50 条记录，返回查询时间与 requestId。不会保存 Token、原始响应或查询结果正文。

这要求业务接口能验证专用 Support Token，或由 SaaS 提供一个很薄的查询适配端点。不能把面向管理账户的开放 API 直接当成用户身份查询；不能把企业级 API Key 放在网页或用它替代客户授权。

## 导入已有 OpenAPI

本地工作台 → 系统与能力 → 以用户身份查询业务 → 导入接口定义。

支持的互操作范围：

| 内容 | 当前支持 |
| --- | --- |
| 格式 | OpenAPI 3.0.x / 3.1.x JSON，最多 500 KB、500 个 path |
| 操作 | GET，必须有合法且唯一的 operationId；最多注册 100 项 |
| 参数 | path/query 的 string、number、integer、boolean；字符串 enum；默认序列化 |
| 引用 | `#/components/...` 本地引用，禁止循环和超过 8 层的引用链 |
| 响应 | 200 application/json：对象、对象数组，或包含一个数组字段的对象 |
| 字段投影 | 最多 30 个基本类型字段，支持有限层级的对象路径；不展开嵌套数组 |
| 自动排除 | writeOnly 字段，以及常见密码、密钥、Token 字段名 |
| 不导入 | 写方法、GET body、操作级 servers 覆盖、header/cookie 参数、复杂参数结构 |

GET 方法名不能证明服务端没有副作用，审核时应确认该端点只读。

不支持的项会逐项说明原因，不会静默注册为可执行能力。原始 OpenAPI 的完整业务验证规则仍由 SaaS 执行；导入器提供受限参数合同，不是通用 OpenAPI 客户端或认证方案自动转换器。

如果响应很复杂，建议提供一个面向当前用户的简单 JSON 查询端点，并为它写清晰的 OpenAPI 定义。配置的 `rowsPath` 为空表示根对象/数组，非空表示从该对象路径读取记录。

## 注册配置示例

以下字段放在项目配置中，也可通过工作台导入和编辑：

```json
{
  "businessQueries": {
    "baseUrl": "https://api.example.com",
    "operations": [{
      "id": "orders.get",
      "title": "查询订单详情",
      "description": "查看当前用户有权访问的订单",
      "path": "/api/orders/{orderId}",
      "fields": [{"name":"orderId","label":"订单编号","type":"string","in":"path","required":true}],
      "rowsPath": "",
      "columns": [{"path":"id","label":"订单"},{"path":"status","label":"状态"}],
      "roles": ["order-reader"],
      "enabled": true
    }]
  }
}
```

项目基础地址可以带固定 API 前缀；路径附加到该前缀后。HTTPS 是默认要求，HTTP 仅允许明确的本地测试主机。参数不能改变服务器或方法，path 参数值仅支持字母、数字、下划线、连字符。额外参数被拒绝，字符串最多 500 字；数值范围限制为 ±1e12。

注册角色按任意一个匹配开放。角色来自签名 Token，但实时撤权、租户成员关系和业务对象所有权仍由 SaaS 校验。Core 不相信客户端提交的身份字段；业务参数也不会改写 Core 当前身份。

## 前端调用

```js
const { queries } = await client.listBusinessQueries();
const result = await client.queryBusiness('orders.get', { orderId: 'ORD-1001' });
// result.columns、rows、retrievedAt、truncated、requestId
```

浮窗和内嵌助手通过[持续对话](conversation.md)识别查询、追问必填参数，并在消息中返回结果；没有模型时也能通过意图匹配与能力选项使用。独立页保留“查业务”目录与表单。每次查询只调用一个已登记的操作，不自动展开多步工具计划。

错误处理：`QUERY_NOT_ALLOWED` 表示操作未启用或当前角色不允许；`BUSINESS_NOT_ACCESSIBLE` 合并记录不存在与无权限，避免泄露业务对象存在性；`BUSINESS_RESPONSE_INVALID` 表示超时、响应过大或结构不符合约定等失败。失败不会伪造业务状态。

每次业务调用最长 10 秒，原始响应最多 256 KB，字段文本最多 2,000 字，最多展示 50 条。禁止 HTTP 重定向，字段白名单不代替敏感资料审核。

## 可运行的验证实例

`examples/identity-bridge/queries.ts` 包含 OpenAPI 与独立 SaaS HTTP 实现。示例 SQLite 中 Alice 只能看 ORD-1001、ORD-1002；同租户 Bob 只能看 ORD-1003；另一租户 Nina 只能看 ORD-2001。SaaS 回包中故意保留一个未批准的内部字段，用于验证 Core 字段投影。

“查看我的通知偏好”和“修改我的通知偏好”共享业务数据库。因此可以查询 → 预览 → 确认 → 再查询，以真实持久化结果检验完整链路。
