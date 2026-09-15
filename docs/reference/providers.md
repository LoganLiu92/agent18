# Provider 与 Tool 注册规范（0.6）

领域能力与传输协议分开：Knowledge、Observability、Source 和 Coding 描述业务语义；native、HTTP、OpenAPI、MCP 描述如何连接。`ToolTransport` 只描述 discovery/call 边界，本版没有 MCP 客户端或自动连接任意 Server。

## 两个注册中心

`ProviderRegistry` 位于 provider-contracts：安装 ProviderManifest、transport 和 ToolBinding。每个 binding 包含工具描述、输入/输出 Zod schema 及 invoke。它拒绝重复注册和能力不匹配。原生代码是部署者信任的代码，不应直接加载客户上传的脚本。

`ToolRegistry` 位于 application：每次调用查询 `control.providers` 与 `control.tools`，要求二者已批准，并与进程内绑定的版本、能力、语义与 schema 一致。注册后的未审核候选不能执行，发现结果不能自动创建权限。已有业务 API 与写入桥继续保留专用验证/执行器，并共用工具审核元数据。

## 服务端安装入口

Core 工厂 `buildApp(config, { providers, caseWorkflow, environment })` 接受部署者安装好的 ProviderRegistry、服务端 CaseWorkflow 和可信环境。导入和批准 manifest 后，由自定义服务入口传入这些依赖，再启动返回的 Fastify app；不需要修改 Run 执行器或客户 API。省略扩展时保持默认知识工作流，省略环境时使用 production。

这些是服务启动参数，没有对应的客户 HTTP 参数。`caseWorkflow.input(report)` 应只从显式报告中提取有界线索；工具仍必须对输入做 schema 校验，并在上游核对租户和对象权限。

## 工具描述

必须填写 `id/version/capability/provider/effect/stage/audience/risk/resourceTypes/environmentPolicy`，审核状态由 Owner 持久化。不要在 manifest 放凭据、任意客户 URL 或原始业务数据。工具/Provider 语义改变时递增版本，排队 Run 的指纹使原任务停止执行，部署者应审核并重新提交新的工作流。

调用上下文只有可信 scope、requestId 与 AbortSignal。输入使用独立 schema，输出也使用独立 schema，例如日志工具可以把 Evidence.kind 限为 log；共同 envelope 再做范围、provenance 和可见性检查。不要返回 `unknown[]` 让 Core 重新适配供应商。

面向 Case 历史的 Provider 必须实现 `visible(scope, evidence)`，按当前来源 ACL/发布状态复核已存证据。未提供该能力的 Provider，其历史证据默认不对客户释放。撤下源或 Provider 后，应验证过去的 Case 同样不可见。

## Owner CLI

```sh
pnpm registry list
pnpm registry import ./reviewed-provider-candidate.json
pnpm registry inspect your-provider
pnpm registry approve your-provider <inspect 返回的完整 fingerprint>
pnpm registry revoke your-provider
```

`import` 强制 pending，不能凭 JSON 中的 approved 字段批准工具。审核时核对代码、领域 schema、上游身份、租户过滤、脱敏、时间/数量限制、transport、风险和环境；只有完成核对再执行 approve。fingerprint 校验使审核期间发生的配置变化无法沿用旧确认。

Manifest 的结构：

```json
{
  "id": "your-provider",
  "version": "1.0.0",
  "transport": "native",
  "capabilities": ["logs.search"],
  "tools": [{
    "descriptor": {
      "id": "your.logs.search",
      "version": 1,
      "review": "pending",
      "capability": "logs.search",
      "provider": "your-provider",
      "effect": "READ",
      "stage": "READ",
      "audience": "ENGINEERING",
      "risk": "LOW",
      "resourceTypes": ["log"],
      "environmentPolicy": ["staging"]
    },
    "schemas": { "input": {}, "output": {} }
  }]
}
```

上面的空 schema 仅展示文件形状，不能作为实际调用合同。用 `bindingSchemas(binding)` 导出代码中真实的 JSON Schema 填入后再导入。审核运行中会核对完整 schema，空 schema 无法冒充已有实现。需要新增部署/工程身份入口才能运行 ENGINEERING 工具；现有客户身份不会获得它。

## 不变量

- 未绑定、未审核、已撤销、版本/字段漂移：调用前拒绝。
- 输入错误：适配器没有被调用；输出错误或跨 scope：整批拒绝。
- 调用期间撤销：不发布晚到结果；历史读取再次检查。
- 通用 Run 只调用 READ/READ；业务写入只走现有 prepare/confirm/receipt，不能靠改 transport 绕过。
- 高风险需要真实审批验证；本版本没有通用审批签发服务，不应伪造 valid=true。

可运行参考是 `tests/security/registry.integration.test.ts` 的合成日志 Provider，以及 `packages/application/src/knowledge-binding.ts` 的现有知识适配器。前者证明替换能力的执行机制，后者是实际默认工作流；真实第三方连接器需另行做供应商和现场验收。
