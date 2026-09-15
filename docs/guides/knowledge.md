# 配置代码、文档与模型

agent18 把已有资料分为“来源快照”和“发布知识”。部署者负责选择来源、受众及可见租户。客户 HTTP API 只能读当前已发布、当前租户可见的条目，不能配置仓库或读取内部条目。

## 配置来源

先运行 `pnpm knowledge init`。以下是 `.local/knowledge.json` 示例（本地相对路径以配置文件所在目录为基准）：

```json
{
  "projectKey": "invoice-demo",
  "mode": "model",
  "maxModelCalls": 100,
  "sources": [
    {
      "id": "product-guide",
      "name": "产品使用文档",
      "kind": "directory",
      "location": "/srv/product/docs",
      "include": ["**/*.md", "**/*.txt"],
      "exclude": ["internal/**"],
      "audience": "customer",
      "tenantIds": []
    },
    {
      "id": "product-code",
      "name": "业务代码",
      "kind": "git",
      "location": "git@github.com:your-org/your-saas.git",
      "ref": "main",
      "include": ["src/**", "docs/**", "README.md"],
      "audience": "internal"
    }
  ]
}
```

- `kind` 支持 `directory` 与 `git`；Git URL 为 HTTPS `.git` 或 `git@host:path.git`。使用宿主机 SSH 身份和已信任的 host key，不把密码/Token 放在 URL 中。
- Git 使用 bare 仓库读取对象，固定到 `FETCH_HEAD` commit；不 checkout、不运行 hook、构建脚本、代码或子模块。不承诺完整抓取任意大型仓库所需的时间与磁盘预算。
- 默认支持 Markdown、TXT、RST、常见源码、JSON/YAML/TOML/XML/SQL；PDF、Word、图片/OCR 暂不支持。应先导出为文本。
- 隐藏文件、依赖和产物目录、常见凭据文件、符号链接、硬链接、二进制与匹配密钥特征的文件会跳过。密钥识别是尽力过滤，不能替代来源审核。
- 默认上限：2,000 个文件、20 MB 总正文、单文件 256 KB、20,000 个片段。`maxFiles/maxTotalBytes/maxFileBytes` 可在 schema 范围内调整。超出总量会让整个构建失败，不发布不完整快照；单文件过大记录为跳过。
- 没有设置 `audience` 时为 `internal`。`customer` 表示允许发布给客户；`tenantIds: []` 表示同项目所有已接入租户。非空数组只允许列出的租户。

## 自带模型 API

创建权限为 600 的 `.local/model.env`（该路径已忽略，不提交）：

```dotenv
AGENT18_MODEL_BASE_URL=https://your-model-provider.example/v1
AGENT18_MODEL_NAME=your-supported-model
AGENT18_MODEL_API_KEY=your-private-key
AGENT18_MODEL_MAX_TOKENS=2048
AGENT18_MODEL_TIMEOUT_MS=30000
AGENT18_MODEL_TOKEN_LIMIT_FIELD=max_completion_tokens
AGENT18_MODEL_JSON_MODE=true
```

模型适配器使用兼容 OpenAI 的 `POST /chat/completions`，发送 `messages` 并读取 `choices[0].message.content`。支持 JSON object 模式；后端必须支持所配置的模型和参数。兼容供应商可能要求将 token 字段改为 `max_tokens` 或关闭 JSON 模式；关闭后仍强制解析、校验 JSON。协议依据：[OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。这不是所有供应商已验收的兼容承诺。

HTTPS 是默认要求；本地模型可使用 `http://localhost`、`127.0.0.1` 或 Docker 的 `host.docker.internal`。容器内 `localhost` 指容器自身。请求禁止重定向，响应限 128 KB，超时/鉴权/配额错误只返回错误码。

CLI 自动加载 `.local/model.env`；Compose Core 通过可选 `env_file` 加载。更改模型配置后运行 `pnpm demo:start` 重建/重建容器配置；单纯 restart 不会读取变化的容器环境。模型 Key 不会发往浏览器或 Worker。部署者选择模型供应商意味着允许向该供应商发送所选资料片段、客户问题和候选业务操作；在导入客户私有代码前确认这个数据范围。

## 构建、检查、发布和撤下

```sh
pnpm knowledge sync product-guide
pnpm knowledge status
pnpm knowledge export <build-id> > .local/review.json
pnpm knowledge publish <build-id>
pnpm knowledge disable product-guide
```

`sync` 不带来源 ID 时按配置顺序构建所有来源。`maxModelCalls` 是每个来源每轮构建的调用上限，默认 100。超限时构建失败，已成功的模型输出保存在索引缓存，下次相同输入可以续用。每次传入同一文件至多 8 个片段，模型生成最多 8 篇知识条目，并必须引用这些片段的 ID。分类包含系统概览、架构模块、接口数据、业务流程、配置部署、问题排查。

缓存键包含提示词、模型配置标识、受众和完整片段。未修改内容可复用模型输出；构建最终仍形成完整文章快照。没有向量数据库或 Embedding 调用：当前检索使用 PostgreSQL GIN、英文标识符和中文双字词重合排序，不能保证语义召回率。

`mode: extractive` 完全不调用模型，自动按文件、标题和类别形成原文条目，可用于首次验收。它不会声称已经完成业务语义总结。`mode: model` 会整理语言，但引用 ID 有效不代表每一句推断都准确，应审核导出内容后发布。

发布以单次数据库事务切换来源的活动版本。失败构建不替换当前版本；不同来源分别发布，不提供跨来源的一次性发布。发布旧构建可回滚，同时恢复该构建的受众配置。切换到内部受众或修改租户列表的构建会先停止当前来源对客户开放，直到重新发布。`disable` 即刻停止后续读取；旧 Case 详情中的知识引用也会重新验证可见性。已经送达客户端或模型供应商的内容无法被远程收回。

数据库保存构建报告、生成条目、文件位置与内容指纹、模型缓存，不保留所有原始源文件。目录来源没有 Git commit，以文件内容清单指纹作为版本。对更新频繁的生产源代码优先使用 Git commit，以避免扫描时文件变化。同步目前由部署者手动/自有调度调用 CLI；未实现 webhook、内置调度器或文件监控。

## 常见问题

- `MODEL_NOT_CONFIGURED`：模型模式缺少完整 BASE_URL/NAME/API_KEY。
- `MODEL_ARTICLES_INVALID / MODEL_REFERENCES_INVALID`：输出字段或引用不合法，该构建不发布。
- `SOURCE_BUDGET_EXCEEDED`：缩小 include 范围或合理调整上限；拆分成多个知识源。
- `NO_INDEXABLE_FILES`：路径、include 或过滤结果为空；检查支持格式及文件权限。
- `GIT_READ_FAILED`：检查宿主机 SSH、host key、仓库权限、ref 和 60 秒单命令超时。
- 网站没有知识：检查项目 `knowledge: indexed`、构建是否发布、受众/租户范围。`pnpm knowledge enable` 可更新本地项目配置，随后重启 Core。


## 持续更新与多项目

`pnpm knowledge watch 300` 每五分钟重读来源配置并构建变化。内容、修订、受众、模型身份与构建规则签名相同则复用最近就绪构建；任何变化产生新草稿，需要再次审核发布。失败保留上一发布版。此进程不会因浏览器关闭而停止，可由主机 systemd/launchd 管理。

工作台按项目保存 `.local/knowledge.PROJECT.json`，切换向导项目时恢复对应来源。`.local/knowledge.json` 是当前选择；持续任务建议通过 `AGENT18_KNOWLEDGE_CONFIG=.local/knowledge.PROJECT.json` 固定到一个项目，避免向导切换影响进程。同一项目由一份完整来源配置管理；不同项目可运行独立 watch。

watch 每轮对配置中已移除的来源执行撤下，对受众收紧立即撤下旧版。关闭 watch 不删除已经发布的内容。只修改模型环境文件需要重启进程；命令启动时加载模型配置。

模型生成条目仍需要业务审核。客户可见来源宜选操作指南、FAQ 和公开接口资料，内部源码保持 internal；不要把“自动生成”理解成无需审核就能完整公开所有仓库内容。
