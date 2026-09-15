# 安装与公开部署

本指南覆盖从干净克隆到真实 SaaS 单机接入。默认部署适合开发、评估和小规模自托管；多实例、高可用和生产 SSO 需按自身环境配置。

## 环境要求

- Node.js 24.14.x（主版本限制 `<25`）、pnpm 11.19.0。
- Docker Engine / Docker Desktop，Docker Compose v2，支持 `--wait`、可选 `env_file` 与 profiles。
- Git；私有 Git 知识源需要宿主机已有只读身份及 `known_hosts`。
- 可用端口：Core 4318、示例 SaaS 4319、本地管理 4321、PostgreSQL 54328、OPA 8188。
- 为源码构建、Docker 镜像和数据库提供磁盘空间。模型调用、Git 拉取需要对应网络连通性。

```sh
git clone git@github.com:LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

`pnpm start` 顺序生成配置、构建并启动演示 Compose、启动本地工作台。它会生成随机数据库密码、用户身份密钥和独立工作负载 Token；重复 setup 保留已有配置和数据。第一次构建需要下载镜像和依赖。

启动后：

- `http://localhost:4321/setup`：输入终端的 Owner access code。
- `http://localhost:4319/example`：独立的示例 SaaS，带浮窗助手；加 `?mode=inline` 体验内嵌形式。
- `http://localhost:4318/docs`：本手册的网页版本。
- `http://localhost:4318/health/ready`：Core、数据库和策略健康检查。

关闭工作台终端不会停止 Docker 服务。之后用 `pnpm setup:ui` 重开工作台，用 `pnpm demo:stop` 停止演示；停止不会删除 PostgreSQL 数据卷或 `.local`。

## 初始化步骤

1. **连接系统**：可以先选演示系统，或注册自己的项目、网站 Origin、租户、Issuer 和公开 JWKS。
2. **连接模型**：测试你自己的兼容模型接口并保存 Key，或先使用原文检索。
3. **选择知识来源**：本地目录或 Git、文件范围、客户/内部受众、可见租户。
4. **构建与发布**：检查实际文件与文章数、文章正文、文件和行号引用；明确发布后才对客户可见。
5. **选择入口**：浮窗、内嵌区块或独立页面；获取示例接入代码并应用 Core 设置。

初始化完成后默认打开接入工作台。工作台可重新检查部署，编辑项目身份，导入 OpenAPI 查询，配置业务桥，跟进客户问题；知识和模型仍通过同一个向导管理。

## 连接真实 SaaS

按照[身份接入](integration.md)、[业务查询](business-queries.md)和[业务写入](business-actions.md)完成后端适配。只有配置 Key 和代码，不会自动获得现有系统的登录会话或业务对象权限。

注册完成后，先用两个用户、两个租户进行权限验证。不要把公开演示签发器当成生产身份服务。

## 单机公开部署

1. 配置真实项目，使用 HTTPS 网站 Origin，导入并发布自己的知识，将该项目设为 indexed。
2. 备份已有部署；执行以下命令选中真实项目并准备公开配置：

```sh
pnpm backup
pnpm deploy:prepare your-saas https://support.example.com
pnpm deploy:start
# 如果此主机之前运行过演示，单独停止演示服务：
docker compose --env-file .local/compose.env -f deploy/compose/compose.yaml stop identity-demo
```

`deploy:prepare` 保留原配置副本，仅让指定真实项目出现在活动配置中；不删除其他项目的数据库记录。它拒绝演示签发者、无网站 Origin、非 HTTPS 公开地址，以及尚未启用 indexed 的项目。此命令不是 SaaS 权限验收器；真实鉴权仍需接入测试。

`deploy:start` 只启动 PostgreSQL、OPA、迁移、Core、Worker；`identity-demo` 处于独立 demo profile。公开部署可由配置文件管理多个真实项目，示例准备命令针对一个项目简化首次上线。

3. 把 `deploy/proxy/Caddyfile.example` 中的域名替换为公开 Core 域名，在同一主机安装配置 Caddy。DNS 指向主机，允许证书签发所需的入站连接。代理连接回环地址 `127.0.0.1:4318`，数据库与 OPA 保留回环绑定。
4. 设置宿主网站 CSP，允许从 Core 加载模块并发起 API 请求。工作台中 allowedOrigins 必须是宿主网站的精确 Origin，不带路径和尾斜杠。
5. 执行 `pnpm run doctor`，再从真实 SaaS 完成知识、查询、业务确认、问题与回复验收。

Core 需要出站访问配置的模型与业务 API。Worker 仅访问 Core/队列。容器中的 localhost 不是宿主机；开发时需要在工作台填容器内可达地址，例如 `http://host.docker.internal:PORT`（Linux 需自行配置 host-gateway）。正式服务优先使用可解析的 HTTPS 地址。

本地工作台仅绑定 `127.0.0.1:4321`，不提供远程管理登录。远程维护时使用到部署主机的 SSH 本地转发，浏览器仍打开 `http://localhost:4321/setup`；不要把 4321 发布到公网。

## 更新版本

```sh
pnpm backup
# 拉取已经审核的代码版本，并检查 CHANGELOG
pnpm install --frozen-lockfile
pnpm deploy:start   # 演示环境用 pnpm demo:start
pnpm run doctor
```

Compose 的一次性迁移任务会应用新增 migration，并校验已应用文件的 SHA-256。不得修改历史迁移来绕过校验。发生不兼容迁移时，先恢复到新的数据库再进行切换，参见[运维指南](operations.md)。

配置文件通过原子替换保存。Docker 挂载单文件可能仍引用旧文件，因此更新身份、项目或业务配置后必须**重新创建 Core 容器**；工作台“应用到运行服务”会执行这个动作，普通 `docker restart` 不能替代。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 端口已占用 | 先确认是哪个服务占用；本项目已有部署可直接重开 setup:ui，不需要再次克隆 |
| Docker build 失败 | 检查镜像仓库/包仓库网络、Node 和 pnpm 版本；保留旧数据卷 |
| readiness 503 | 运行 `pnpm run doctor` 和 `pnpm logs`，检查数据库、迁移、OPA |
| 配置保存后页面没变化 | 使用“应用到运行服务”或重新执行 deploy:start/demo:start |
| 无法进入独立支持页 | 必须从 SaaS 的按钮通过 openSupportPage 打开，允许弹窗并保留原窗口 |
| 4319 身份请求失败 | 这是演示服务；本地体验需 demo profile，真实系统应调用自己的签发入口 |
