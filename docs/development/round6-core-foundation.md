# 0.6 Core Foundation 验收记录

日期：2026-09-15。基于 0.5 的现有 L1–L3 链路升级；范围说明见 [核心审查与迁移](../overview/agent18-0.6-core.md)。

## 验证结果

| 检查 | 本地结果 |
| --- | --- |
| 格式、TypeScript、客户 UI 和 SDK 构建 | 通过 |
| 回归测试（含真实 PostgreSQL、OPA 和 SaaS 示例） | 18 个测试文件、138 项通过 |
| 独立 Rego 测试 | 15/15 通过 |
| SDK 体积 | gzip 9,702 字节，低于 15 KiB 预算 |
| 公开 API | 23 个操作；Evidence、Context 和 RunStep 合同已更新 |
| API/Worker 恢复 | outbox 保留、恢复处理、终态重复执行不产生额外证据或审计 |
| 全新安装旅程 | 干净配置与数据库、知识发布、真实查询/预览/确认、客户与支持对话、备份、隔离恢复、显式激活通过 |
| 现有数据库升级 | 347 条历史 Case 保留；352 条旧引用完成 envelope 回填；缺失 payload、capability 和 Run 指纹均为 0 |
| 浏览器回归 | 单一对话入口、历史问题读取与当前有效 Evidence 展示正常 |

计数来自本地验收快照，不代表真实客户生产环境。数据库记录数包含历轮合成测试；未在公开仓库保存数据库、备份或凭据。

## 新增反向验证

合成日志 Provider 通过原有 CaseService/RunService 执行：持久化 log Evidence，记录实际 tool/provider、耗时和授权结果。无需将执行器改成 logs.search 专用代码。

测试同时覆盖跨组织/项目/租户/用户结果拒绝、限制受众与敏感度、未知字段、缺失知识 Citation、重复 Provider、未审核/撤销、schema 漂移、排队 Run 指纹改变、调用期间撤销不发布晚到结果。高风险能力记录 APPROVAL_REQUIRED 且适配器调用次数不增加。

Owner CLI 实际导入候选并强制 pending；错误审核指纹不能批准，正确指纹才能启用；App 数据库账号不能自审 Provider。原有业务角色、对象隔离、明确确认、幂等和 uncertain 回执检查继续通过。

旧来源版本撤下后，其历史证据仍按现行可见性规则隐藏。保留迁移后的记录不等于重新公开被撤回的知识。

## 仍未验收的范围

没有真实 Loki、OTel、Sentry、RAGFlow 或在线 MCP Server 接入，没有根因判断、自动修复、沙箱或 PR 创建。模型 Key 未配置，当前本地使用原文索引与确定性引导。合成日志测试仅证明核心抽象与权限流程，不是日志产品兼容性或生产排障效果证明。
