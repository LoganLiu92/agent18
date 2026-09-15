# Contributing to agent18

欢迎提交问题、改进文档和贡献实现。当前可执行范围见 [0.5 机制综述](docs/overview/agent18-0.5-overview.md)，扩展计划见[路线图](docs/planning/mvp-roadmap.md)。建议先提出具体场景、当前限制和验收方式，避免只有接口占位而没有可运行适配器。

## 开发环境

```sh
pnpm install --frozen-lockfile
pnpm setup
pnpm demo:start
pnpm setup:ui
```

前端开发可运行 `pnpm dev:console`；后端与 Worker 分别有 dev:server/dev:worker。不要同时让宿主进程和 Docker 占用相同端口。修改运行配置后要重新创建对应容器。

## 代码与接口约定

- 使用严格 TypeScript 和 Zod；字段默认拒绝额外输入，错误使用稳定 code，不返回凭据或原始上游错误。
- 编排在 application，权限与状态约束在 domain/policy/persistence，外部接入通过明确合同；browser SDK 不导入 Node 运行依赖。
- 新工具必须声明注册、角色、读写阶段、响应投影、预算和真实/模拟来源；模型与资料不能自行注册执行能力。
- 不修改已经应用的 migration，新增顺序编号文件。关键数据必须有 scope、外键、RLS 与拒绝路径测试。
- API 变化同步 `apps/server/src/openapi.ts`、SDK 和文档；新增页面处理加载、空数据、失败、窄屏和键盘交互。
- 不提交 `.local`、`.env`、依赖、产物、备份、模型 Key 或真实客户记录。测试使用合成数据。

## 验证与 PR

```sh
pnpm check
pnpm test:policy
pnpm test:integration
pnpm test:recovery
pnpm test:journey
```

按改动选择必要测试；身份、数据库、调用、发布与恢复变化必须验证允许和拒绝路径。恢复测试会暂停本地演示组件；journey 使用新建隔离 Compose 项目和固定的专用测试端口。

PR 说明具体问题、最终行为、验证结果及依赖接入者的边界。引用本地模拟测试时明确模拟范围，不把构建/容器成功写成真实 SaaS 验收。格式使用 `pnpm format`；新增技术文件同时更新手册导航和版本记录。

CI 会构建、测试、运行恢复及安装旅程，并保存本次 SDK/API 交付清单。`release:check` 是本地交付检查，不会自动向 npm 或镜像仓库发布。

## 沟通与许可证

公开 Issue 适合合成数据复现、功能请求和文档问题。安全问题先阅读 [SECURITY.md](SECURITY.md)。讨论请聚焦行为和证据，尊重不同经验与语言背景；不接受骚扰或发布他人私密资料。

提交者应拥有贡献内容的授权。Core 贡献遵循 Apache-2.0，Web SDK 贡献遵循其目录中的 MIT 许可证。
