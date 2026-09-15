# Contributing to agent18

当前交付范围见 [0.3 机制综述](docs/overview/agent18-0.3-mechanism.md)。先用 `pnpm install --frozen-lockfile`、`pnpm setup`、`pnpm demo:start` 启动本地环境。

提交前运行 `pnpm build`、`pnpm test`；涉及身份、权限、数据库、Provider、任务执行的改动，还需运行 `pnpm test:integration` 和 `pnpm test:policy`。集成测试只针对本项目的本地合成数据。

- 新增 Provider 必须声明能力、版本和 fixture/live 状态，补正向与负向合同测试。
- Core 不导入应用层入口。应用编排依赖领域与 Provider 合同，适配器不持有用户可覆盖的授权范围。
- 已应用的 migration 不可改写；新增带序号的 migration。密码、Token、`.local/`、`.env` 和客户数据不得进入提交。
- 改变权限时同时更新 Rego、拒绝审计、租户/用户隔离测试与实现状态文档。
- PR 说明触发条件、最终行为、验证结果及剩余集成边界；测试替身通过不等于真实上游验收。

仓库配置了 GitHub Actions 检查；尚未建立 npm/公共镜像发布流水线。提交安全问题前请先阅读 [SECURITY.md](SECURITY.md)。
