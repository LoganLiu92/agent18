# 业务操作助手与代客执行

已有完整代码可帮助 agent18 理解业务，但代码访问权限不等于用户的业务授权。业务操作通过部署者注册的 SaaS 接口执行。模型只能建议一个注册操作及参数，不能提供目标 URL、Shell、SQL 或管理身份。

当前实现：单步操作、类型化参数、业务预览、5 分钟确认窗口、持久化提案、身份/配置复核、OPA、业务回执及不确定结果核对。尚未实现多步自动计划、网页点击代理、跨业务事务补偿或高风险双人审批。

## 注册操作

在项目的 `businessBridge` 配置中给出固定接口和操作列表；通过 `project:configure` 写入可信配置后，用工作台“应用到运行服务”或 `pnpm deploy:start` 重新创建 Core。每个操作默认 `enabled: false`，启用需部署者明确设置。`roles` 必须非空；当前任一匹配角色可请求预览，SaaS 仍执行最终授权。

```json
{
  "businessBridge": {
    "url": "https://your-saas.example/internal/agent18/bridge",
    "actions": [{
      "id": "order.note.update",
      "title": "修改订单备注",
      "description": "修改当前用户有权编辑的订单备注，不改变金额或订单状态。",
      "roles": ["order-editor"],
      "enabled": true,
      "fields": [
        {"name":"orderId","label":"订单编号","type":"string","required":true},
        {"name":"note","label":"备注","type":"string","required":true}
      ]
    }]
  }
}
```

字段支持 `string/number/boolean`、必填、字符串枚举；不接受额外字段，普通字符串上限 500 字。复杂对象、批量导入和通用 JSON Schema 暂未开放。注册表由部署者提供，知识文档或模型输出无法创建或启用操作。

## SaaS 业务桥合同

Core 只向固定 HTTPS URL 发送 POST（本地测试地址允许 HTTP），禁止重定向，10 秒超时，响应上限 16 KB。请求携带用户本次 HTTP 请求的 `Authorization: Bearer <support-token>`，不会保存 Token。业务桥应验证自己的 issuer、audience、签名、项目、用户与租户，并检查当前业务权限。接口地址固定不代表接口可跳过鉴权。

### prepare：权限校验和预览，禁止产生业务写入

```json
{
  "phase":"prepare",
  "actionId":"order.note.update",
  "arguments":{"orderId":"order-001","note":"联系客户确认配送时间"},
  "idempotencyKey":"<proposal-uuid>"
}
```

成功响应：

```json
{"summary":"将订单 order-001 的备注修改为：联系客户确认配送时间。","revision":"order-001:version-7"}
```

`summary` 是用户可理解的具体变更，应含重要对象/目标/参数。`revision` 是业务版本或短期预览授权标识。Core 持久化操作、参数、预览和注册表哈希，客户确认接口只接受 `{ "confirmed": true }`，不能在确认时替换参数。

### execute：再次校验后提交，业务数据与幂等回执同事务

```json
{
  "phase":"execute",
  "actionId":"order.note.update",
  "arguments":{"orderId":"order-001","note":"联系客户确认配送时间"},
  "preview":{"summary":"将订单 order-001 的备注修改为：联系客户确认配送时间。","revision":"order-001:version-7"},
  "idempotencyKey":"<same-proposal-uuid>"
}
```

SaaS 必须重新检查对象属于当前租户、用户有操作权限、业务状态允许、revision 未变化，并检查参数与已预览内容相同。业务状态变化时返回拒绝，要求生成新预览。将幂等键绑定项目/租户/用户/操作和参数；重复相同请求返回原回执，参数不同则拒绝。

```json
{"status":"succeeded","message":"订单备注已更新。","receiptId":"receipt-001"}
```

明确未执行时：

```json
{"status":"rejected","message":"订单已锁定，不能修改备注。"}
```

Core 的行锁保证同一提案只进入一次执行发送。Core 先持久化 `executing` 和确认审计，再发请求；收到经过校验的业务回执后记为成功/拒绝。HTTP 出错、响应不合规、超时或进程中断都不能被当成业务未执行。

### status：只查回执，禁止重发或补做操作

```json
{"phase":"status","actionId":"order.note.update","idempotencyKey":"<same-proposal-uuid>"}
```

返回既有 `succeeded/rejected` 回执；仍在执行返回 `pending`；尚无回执返回 `not_found`。后两者在 Core 中保持 `uncertain`，因为一个延迟请求仍可能到达。用户点击“查询业务回执”或调用 SDK `reconcileAction` 后更新结果。系统不自动重复执行；无法核对时由 SaaS 的业务运维处理。

这是可恢复的投递与回执设计，不宣称分布式 exactly-once。正确性依赖业务桥真正实现幂等、对象权限与事务化回执。任意业务接口如果只返回成功文字、没有真实授权和持久化，不能作为可靠业务桥。

## 本地完整示例

`examples/identity-bridge/business.ts` 实现“修改自己的邮件通知偏好”：

- 只接受本地演示项目的签名 Token 和 `tenant-admin` 角色。
- SQLite 数据按项目/租户/用户分区，普通用户不能选择其他用户。
- 预览返回偏好版本，执行再次比较版本。
- 偏好变更与幂等回执同事务写入独立 SaaS 数据文件。
- Core 不持有该 SQLite 文件，只有业务示例容器挂载它。

```sh
pnpm demo:actions
pnpm demo:start
```

数据位于 `.local/business-data/preferences.sqlite`，停止容器后保留，不提交 Git。本地 SQLite 使用 Node 24 内置实验性模块；它是示例业务持久化，agent18 Core 持久化使用 PostgreSQL。

## 模型规划

配置模型后，`POST /api/actions/plan` 根据用户描述和当前身份允许的注册列表生成 `{actionId,arguments}`。输出经过同样的参数校验，再调用 `prepare`，不执行写操作。缺少资料返回 `ACTION_NEEDS_DETAILS`，前端可补参数后重试。无需模型也可以通过动态表单选择操作。

高风险业务（付款、删除、账户权限、对外发送等）还应在业务桥内部实施业务系统本来要求的二次验证、审批和额度控制；本版本的单人确认不是那些机制的替代品。


## 工作台配置与验证闭环

在本地接入工作台 → 系统与能力 → 经确认办理业务编辑桥接配置。空白表示保留原设置；要停用全部动作，保存 `actions: []`，或将具体动作 enabled 改为 false，然后应用到运行服务。

三种客户入口都支持查询和办理业务：浮窗与内嵌助手通过[持续对话](conversation.md)引导，独立页提供目录与表单。示例中先查询通知偏好，确认修改后再查询验证：仅生成预览不改变数据；重复确认不会增加业务数据版本。真实接入也应选择一个可回读验证、作用范围明确的业务作为首条验收链路。
