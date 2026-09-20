# 宿主业务上下文与失败事件

0.8 为已有 SaaS 增加明确的业务事件入口。宿主告诉助手“当前在哪个业务页面、哪个对象、哪个操作失败”，用户说“为什么不行”时进入对应问题的上报预览。助手不会仅凭错误码宣称根因，也不会自动重试业务操作。

## 路由与当前对象

```js
client.setContext({
  pageUrl: location.href,
  route: 'order-detail',
  entity: { type: 'order', id: order.id },
  appVersion: '2026.09.17',
  frontendVersion: 'a1b2c3d',
});
```

`setContext` 替换当前上下文；请在宿主路由或当前对象变化时调用，传齐需要保留的字段。URL 的 query 和 fragment 会被丢弃。`route` 是最多 120 字符的业务路由标识，只允许字母、数字、下划线、点、斜线和连字符。其他 entity/session/trace/version 字段见 [API 参考](../reference/api.md)。

页面路径、route、entity 或旧版实体字段变化会清空 SDK 已缓存事件。`client.clearContext()` 清空显式上下文与事件；退出登录或切换用户/租户时仍须销毁助手和 SDK，再用新身份创建实例，不能只调用 clearContext。

## 业务失败和恢复

在宿主自己的 API 错误处理处调用：

```js
client.emit({
  type: 'business.operation.failed',
  operation: 'order.save',
  errorCode: 'ORDER_SAVE_TIMEOUT',
  traceId: responseTraceId,
  requestId: responseRequestId,
  // 默认取当前 entity；也可以明确提供本次操作的对象
  entity: { type: 'order', id: order.id },
});
// 后续同一操作、同一对象真正成功时：
client.emit({ type: 'business.operation.succeeded', operation: 'order.save' });
```

可选字段缺失时省略。`operation` 和 `errorCode` 是受限标识，分别最多 80 字符；事件不接受任意 message、payload、Token、角色或租户字段。`traceId` 为 16–32 位十六进制，`requestId` 为最多 100 字符的受限标识。实体 ID 最多 128 字符。事件时间由 SDK 生成，调用方不能指定。

事件缓存在内存中，最多 5 条，10 分钟过期。`emit` 本身不发网络请求；随后对话路由会携带仍有效的事件，或在客户确认上报时持久化到工单。同一操作、对象后来的成功事件会使之前的失败不再触发引导。当前对象不同的失败不用于解释“为什么不行”。服务端也检查事件时间，拒用明显超前的时间线索；这不构成可信事故时间证明。

宿主负责只报告其页面可用的信息。ID 和错误标识也可能包含敏感业务含义，应按项目数据策略筛选。浏览器事件可能被伪造，绝不能据此推导身份、租户、角色或对象访问权限。

## 对话、预览与工程排查

1. SDK 将显式上下文交给 `/api/assistant/route`。近期未恢复的失败配合“为什么不行”“刚才报错”等表达，确定性返回支持引导；此步不建工单，也不执行接口。
2. 浮窗/内嵌展示操作和错误码，形成可编辑标题，准备上下文快照与可选页面采集。客户可以展开核对；取消“附上页面与业务上下文”会同时省略 context 和 capture。
3. 点击提交才建立 Case。表单持有预览时的快照，即使客户切换页面，提交内容也不会悄悄变成新页面的上下文。
4. 本地 Owner 的客户问题和排查详情都能看到已提交事件。只读排查优先使用上报时有效失败事件的 traceId，没有时沿用显式 context.traceId；仍追加服务端验证的项目、租户与用户范围。
5. 后台通过已配置的数据源查询证据，客户只看到安全摘要。事件和日志相符仍不等于已证明根因；完整 Trace 后端与发布版本关联仍待实现。

路由模型当前不接收事件清单、DOM、截图或原始业务响应；失败引导使用确定性规则。事件持久化沿用 Case 的 RLS 和备份规则，尚无独立事件仓库或自动保留删除机制。

## 自建界面的快照

```js
const context = client.getContext(); // 副本，移除过期事件
const capture = await client.capturePage();
// 展示 context 与 capture，待用户确认；保留同一个幂等 key 处理重试
await client.reportCase({
  title: '订单保存失败',
  description: '请协助核对这次操作。',
  context, // 未提供时自动取提交时的当前上下文；{} 表示不附带
  ...(capture ? { capture } : {}),
}, reportKey);
```

独立 `/support` 页目前只交接短期身份，不自动带走宿主页面事件或截图；需要这些线索时使用浮窗/内嵌或自行完成有预览的上报。持续对话版本将已确认保存的聊天文本保存在服务端，刷新后恢复；未确认写入仍需重试，历史不重放业务操作。

## 可运行验证

示例 SaaS 点击“模拟业务异常”，在助手里输入“为什么不行”，应出现 `order.save / ORDER_SAVE_TIMEOUT` 的说明、实体与 traceId 预览。启动 `pnpm observability:demo` 后提交，工作台应能找到对应 Loki 日志及 HTTP/指标证据。点击“恢复演示服务”产生合成恢复事件，之后同样的问题不再归因于此前失败。

`pnpm test:observability` 使用真实 Loki/Prometheus 镜像验证事件 traceId → Case → 持久排查 → 客户摘要隔离。自动测试的业务数据和故障是合成的，目标 SaaS 应使用自己的错误响应标识做同样验收。
