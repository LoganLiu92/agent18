# 页面上下文、自动排查与巡检

本指南连接现有监控系统；没有监控时，也提供独立可选的 Loki / Prometheus 演示组合。所有运维检查只读，不需要把 SSH、数据库管理员或写权限交给 agent18。

当前源码还提供 Tempo 逐 span 范围校验和可信部署记录，配置、签名与未知结果语义见[Trace 与部署证明](advanced-workflows.md)。下方 Loki / Prometheus 演示不包含 Tempo，不能用它证明 Trace 或真实线上版本已经接通。

## 用真实组件跑通演示

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm demo:start
pnpm observability:demo
pnpm setup:ui
```

`observability:demo` 仅适用于保留合成签发者的 `invoice-demo`：启动可选组件，备份原配置，为该项目保存 HTTP / Loki / Prometheus 三项检查，重新加载 Core / Worker / 示例 SaaS。需要先构建并启动本版 demo；它不会推断真实项目的监控配置。Loki 映射到 `127.0.0.1:31310`，Prometheus 到 `127.0.0.1:39090`，均不向公网暴露。镜像按版本与 SHA-256 固定；数据保留七天，持久卷在 `demo:stop` 后保留。

1. 打开 `http://localhost:4319/example`，点击“模拟业务异常”。示例服务产生带 tenant/subject/traceId 的真实 Loki 日志，返回 503，并令 Prometheus 抓取的业务可用性变为 0。
2. 打开右下角助手，输入“提交问题”。检查自动附带的页面上下文和截图，填写描述并提交。
3. 打开 Owner 工作台“巡检与排查”，看到工单关联检查、证据、分析和下一步。完整日志只在此处展示。
4. 点击“立即巡检”，重复异常合并；可点击“接手”。在原示例页面点击“恢复演示服务”，下一次 HTTP / 指标检查恢复；错误日志需要等待一分钟窗口结束后恢复。
5. 选择报告“整理为内部知识草稿”，在知识向导添加返回目录，保持 `internal` 受众，核实后再构建发布。

```sh
pnpm test:observability
# 查看可选组件状态；停止本地完整演示但保留数据：
docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml --profile observability ps
pnpm demo:stop
```

验收命令会改变合成示例的故障状态并创建工单和巡检报告，结束时恢复服务，不应指向共享或正式环境。

## 接入自己的页面

```js
const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  getToken,
  capture: { enabled: true, pageText: true, screenshot: true },
});
client.setContext({
  pageUrl: location.href, // 仅保留符合限制的路径，不包含查询串或 fragment
  entity: { type: 'order', id: currentOrder.id },
  traceId: lastFailedRequestTraceId, // 可选，真实后端返回的 16–32 位十六进制 traceId
});
```

基础采集默认开启，截图默认关闭。浮窗/内嵌上报表单自动调用 `capturePage()`，提交前可预览并取消附带。只用 SDK 自建表单时，显式调用 `const capture = await client.capturePage()`，展示预览后调用 `client.reportCase({ title, description, capture }, crypto.randomUUID())`。`reportCase()` 本身不隐式截屏。不需要采集时设置 `capture: { enabled: false }`；只关闭文字用 `pageText: false`。

页面上下文包括标题、路径、语言、视口、在线状态、有界可见文字、安装 SDK 后的未捕获错误/Promise 异常、可识别按钮点击/浏览器导航和 Performance API 可见的失败资源状态。不会记录 Cookie、localStorage、Authorization、请求/响应正文、完整 URL 或表单输入值；不会回放安装前历史，不保证捕获所有 fetch/XHR 状态、SPA 导航或跨源资源错误。业务请求的 traceId 应由宿主显式传入，不能仅从错误描述猜测。

为敏感区域添加 `data-agent18-private`。采集排除这些区域、表单、contenteditable、iframe 和助手自身，并清洗常见 Token/密码/邮箱格式。截图使用 html2canvas 渲染当前视口，另外排除图片、视频、canvas、SVG 和背景图片，不是逐像素完整屏幕截图。它无法保证识别所有业务机密；自定义敏感组件必须标记并在真实页面检查预览。SDK 销毁会移除监听与缓冲，用户切换时同时销毁 UI 和 SDK。

截图模块 `/sdk/capture.js` 仅按需加载，不增加主 SDK 的 15 KiB gzip 预算。自托管静态 SDK 时同时提供它；宿主 CSP 的 `script-src` 允许模块源、`connect-src` 允许 Core、`img-src` 允许用于预览的 `data:`，严格 CSP 需实际验证。加载/渲染失败会省略截图并说明，其他上下文仍可提交。独立支持页只能采集其自身页面；宿主问题上下文优先从浮窗上报，当前没有跨窗口自动采集原站 DOM 的桥。

## 连接现有 Loki / Prometheus

在 Owner → 巡检与排查 → 连接数据源中配置固定 URL、检查名称、选择条件及间隔，点击“保存并应用检查配置”。URL 必须从 **Core 容器** 可达，容器内 localhost 指向它自己。配置保存到宿主/Docker 两份 server JSON，使用相同观测配置指纹；应用配置会重新创建消费者，短暂中断单机服务。

只读 Bearer 凭据在工作台保存为 `AGENT18_OBS_*` 环境变量，再在检查中引用名称。值符合 Bearer token 字符集，保存在 `.local/observability.env`，工作台只返回变量名和是否配置。当前不直接支持 Basic、云签名或 mTLS；这类认证使用接入方已有的受信任只读代理。不要把凭据放在 URL、查询表达式或 SDK 中。

示例项目配置（保存前替换真实地址、标签与指标）：

```json
{
  "enabled": true,
  "autoInvestigate": true,
  "intervalSeconds": 300,
  "modelAnalysis": false,
  "checks": [
    { "id": "api-health", "kind": "http", "title": "业务 API 可用性", "url": "https://internal-saas.example/health", "expectedStatus": 200 },
    { "id": "business-errors", "kind": "loki", "title": "业务错误", "url": "https://logs.example", "credentialEnv": "AGENT18_OBS_LOGS", "labels": { "app": "your-saas", "environment": "production" }, "tenantLabel": "tenant_id", "subjectLabel": "subject", "tenantHeader": "your-loki-tenant", "contains": "error", "windowMinutes": 10, "minimumMatches": 1 },
    { "id": "service-up", "kind": "prometheus", "title": "服务存活", "url": "https://metrics.example", "credentialEnv": "AGENT18_OBS_METRICS", "query": "up{job=\"your-saas\"}", "comparison": "lt", "threshold": 1 }
  ]
}
```

Loki 使用 `query_range`，固定项目 labels 必须非空。工单查询附加已认证的 tenantLabel，配置 subjectLabel 时再附加用户标签；不能用固定标签覆盖这些 scope 字段。有 traceId 时增加字面量匹配，以任务登记时间附近的有界窗口查询。实际日志必须具有这些标签和一致 traceId；不存在匹配表示窗口内未找到相应信号，不证明没有故障。`minimumMatches` 针对最多 30 条样本，不是全量日志统计。

Loki 的 `X-Scope-OrgID` 是监控存储的租户，可能不同于业务租户。它来自 Owner 固定配置，不能来自浏览器；业务隔离仍依赖 tenantLabel 和上游权限。Loki 自身不提供认证层，公开部署需要既有认证代理。使用官方 [Loki HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/) 与 [认证说明](https://grafana.com/docs/loki/latest/operations/authentication/)。

Prometheus 使用固定 PromQL 的瞬时向量查询，最多评估 100 个序列、展示 30 份证据，任一有效序列超过阈值即异常；空结果、NaN/Inf、超过五分钟的样本显示无法确定。指标通常是项目/服务维度，因此完整结果只给 Owner，客户不能看到全局指标或标签。协议参考 [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/)。

## 服务器与日志采集

agent18 是查询与处理入口，不安装主机 Agent。已有 Grafana / Loki / Prometheus 直接连接；没有采集时由接入方在受控主机安装相应 collector / exporter，把服务和环境标签统一。业务日志建议结构化包含 level、脱敏 message、traceId、业务 tenant；只在确有用户归属时记录 subject。不要将无用户归属的系统日志硬塞进某个用户 scope。

| 检查 | 已有 Prometheus / node_exporter 时的表达式示例 | 条件 |
| --- | --- | --- |
| 主机存活 | `up{job="node",environment="production"}` | 小于 1 |
| CPU 利用率 % | `100 * (1 - avg by(instance)(rate(node_cpu_seconds_total{job="node",environment="production",mode="idle"}[5m])))` | 大于 85 |
| 内存使用率 % | `100 * (1 - node_memory_MemAvailable_bytes{job="node",environment="production"} / node_memory_MemTotal_bytes{job="node",environment="production"})` | 大于 90 |
| 根盘可用率 % | `100 * node_filesystem_avail_bytes{job="node",environment="production",mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{job="node",environment="production",mountpoint="/",fstype!="tmpfs"}` | 小于 10 |

这些是需要按目标标签和系统校验的配置模板。随仓库启动的 Prometheus 只抓取示例业务和自身，不会自动获取你的 Mac、服务器或 Kubernetes 指标。主机指标定义参见 [node_exporter](https://github.com/prometheus/node_exporter)。集中可视化可继续用 Grafana，告警路由可继续用已有告警系统；本版提供工作台中的异常生命周期，没有自动消息通知或服务器修复。

## 证据与知识回流

完整报告和截图只通过对应 Case / 项目的授权入口访问，客户排查摘要不含原始工程日志。模型分析默认关闭；开启后使用部署者配置的模型，发送有界脱敏证据摘要与页面错误，不发送截图。模型分析是待核实建议；不要把“没有匹配日志”解释成“用户操作无误”或“系统正常”。

内部知识草稿保存到 `.local/incident-knowledge/<projectKey>/`，不含完整原始日志，保留报告、证据与时间标识。知识向导添加该目录，保持 internal 受众、补充经核实的处理办法，再构建审核。Case 的人工回复和解决状态独立于监控异常恢复：机器探测健康不会代替客户确认问题已解决。

页面捕获和报告在 Core 数据库持久保存，本版没有自动清理策略。上线前按目标系统的数据保留要求安排受控清理、备份过期与访问管理；关闭采集只影响新上报，不会删除历史记录。组件自身七天保留只适用于演示 Loki / Prometheus，不能代替 Core 的保留策略。
