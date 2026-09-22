# agent18

**AI support that can answer, act, and investigate.**

Help customers get answers, check live data, confirm business actions, and report issues—without leaving your product.

[![checks](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml/badge.svg)](https://github.com/LoganLiu92/agent18/actions/workflows/ci.yml)
[简体中文](README.md) · [Quick start](#quick-start) · [Integration](#integrate-your-saas) · [Handbook](docs/README.md)

agent18 is an open-source support agent for existing SaaS products. It connects product documentation and code, authenticated users, business APIs, and observability sources in one customer-facing conversation.

**Answer · Ground responses in sources.** Use reviewed, published knowledge for product questions and authorized business APIs for live data.

**Act · Preview before execution.** Show the exact change, wait for explicit confirmation, let your SaaS authorize and execute it, then reconcile the receipt.

**Investigate · Give support a starting point.** Collect reviewable page context, consult logs and metrics, and let people follow up. Resolutions can become knowledge drafts for review.

Built for SaaS teams with existing authentication, APIs, and product knowledge who want to self-host support. **Keep your login and business database. Do not give the model administrator credentials.**

[//]: # (agent18:release:start)

Current version: **0.8.0 integration preview**. See the [runtime overview](docs/overview/agent18-0.8-integration.md); source-based, single-host deployment.

[//]: # (agent18:release:end)

## Quick start

Use **Node.js 24.14.x, pnpm 11.19.0, Docker Compose v2, and Git**. These commands build from source and start a local demo with synthetic users and business data—not a public production deployment.

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

Open the [local setup workspace](http://localhost:4321/setup) and enter the **Owner access code** printed in your terminal. Select the demo system, configure a knowledge source, build and review it, publish it, and choose a website entry point.

For day-to-day knowledge and ticket management, use the separate [operator workspace](http://localhost:4318/admin). Create the first administrator in Setup, then grant project and tenant access. The Owner access code is for local deployment maintenance.

**A model API key is optional.** Without one, you can test source retrieval, citations, business queries, confirmed actions, and support follow-ups. Model generation and model-assisted answers require separate configuration; deterministic demos do not validate model quality.

Open the [demo SaaS and floating assistant](http://localhost:4319/example). The built-in UI and most detailed guides are currently in Chinese; these prompts match the demo:

| Try | Expected result |
| --- | --- |
| `查询我的订单` — query my orders | Read the current user's business data. Switch demo users to check the corresponding access boundaries. |
| `关闭邮件通知` — disable email notifications | Review the proposed change and confirm it. Then enter `查看我的通知偏好` to verify the persisted preference. |
| `提交问题` — report an issue | Review and optionally include page context, submit the issue, add details, and follow support replies and progress. |

For knowledge answers, ask a question covered by the document you just published and check the source citations.

Also try the [inline assistant](http://localhost:4319/example?mode=inline). Open the standalone support page from the SaaS support button so it receives the current user's identity. The [local handbook](http://localhost:4318/docs) is served with the application.

### Try a runtime investigation

In a local demo that still uses the default `invoice-demo` project, open another terminal:

```sh
pnpm observability:demo
```

Click “模拟业务异常” in the demo SaaS, report the failure through the assistant, and inspect the associated logs, metrics, and report in the local workspace. This uses real Loki / Prometheus components with synthetic failures. **An investigation report is not proof of root cause.** See the [observability guide](docs/guides/observability.md).

Stop the demo with `pnpm demo:stop`; closing the setup terminal does not stop Docker services. For startup issues, run `pnpm run doctor` and consult the [installation guide](docs/guides/installation.md).

## Your SaaS remains in control

A business write is more than a model choosing a tool:

```text
Registered action → Parameter and policy checks → Exact preview → User confirmation
                  → Identity, permission and revision checks → SaaS execution → Receipt
```

agent18 calls fixed business endpoints using the current user's short-lived identity. **Your SaaS enforces authorization, object ownership, and business rules.** It must commit the mutation and idempotent receipt in the same transaction. Uncertain delivery triggers receipt reconciliation—not a success claim or a blind retry of the write.

Code and documentation provide context, not permission. The model cannot register arbitrary endpoints or execute arbitrary SQL, shell commands, or browser clicks. See the [business action contract](docs/guides/business-actions.md).

## Integrate your SaaS

For another project's coding assistant, copy the [integration prompt](INTEGRATE.md#可以发给另一个项目的任务描述) and require a completed [acceptance report](docs/reference/integration-acceptance.md) with actual evidence.

Start with the [integration task brief](INTEGRATE.md) and add capabilities incrementally.

| Connection | What your system provides |
| --- | --- |
| Identity and website | A backend-issued Support Token derived from a real session; project, tenant, public keys, allowed website origins, and the embedded SDK. |
| Product knowledge | Readable documentation or code, an explicit customer/internal audience, and review before publication. |
| Queries and actions | Reviewed read-only APIs; for writes, a `prepare / execute / status` bridge with transactional receipts. |
| Investigation and handoff | Optional HTTP / Loki / Prometheus / Tempo sources, trusted scope labels, read-only credentials, and scoped operator access. |

OpenAPI import creates candidates from a bounded **GET** subset. Read-only **POST** operations require separate registration and review; they are not automatically imported. See [business queries](docs/guides/business-queries.md).

### Minimal browser integration

First configure [identity issuance, origins, and CSP](docs/guides/integration.md). Then mount the assistant from an ES module on an authenticated page:

```js
import { Agent18, mountFloatingAssistant }
  from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  capture: { enabled: true, pageText: true, screenshot: false },
  getToken: async () => {
    const response = await fetch('/api/support-token', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Support identity unavailable; check your login');
    const { token } = await response.json();
    if (typeof token !== 'string' || !token) throw new Error('Support endpoint returned no token');
    return token;
  },
});

const assistant = mountFloatingAssistant(client, { title: 'Product assistant' });

// Call from the host on logout, user/tenant change, or page teardown.
function disconnectSupport() {
  assistant.destroy();
  client.destroy();
}
```

Replace the example domain and project key. Implement `/api/support-token` in your backend using your existing session and CSRF protections; do not trust browser-supplied users, tenants, or roles. Mark sensitive page regions with `data-agent18-private` and verify capture previews on your actual pages.

Also available: `mountAssistant(container, client)`, `openSupportPage(options)`, or the SDK alone with your own UI. For post-action refresh callbacks, identity changes, and standalone-page handoff, see the [complete integration example](docs/guides/integration.md).

## Version and capability status

Runnable implementations, partial capabilities, and planned work are listed separately. Integration and production acceptance are not assumed.

**Current source code is not the same as your active deployment.** The independent operator workspace, persistent conversations, ticket assignment, knowledge maintenance, and business analytics require the matching migrations, configuration, and permissions. Updating documentation does not upgrade a running instance. See the [workspace guide](docs/guides/support-workspace.md) and [round 17 development record](docs/development/round17-product-workflows.md).

[//]: # (agent18:capabilities:start)

| Capability | Status | Available | Requirements and limits |
| --- | --- | --- | --- |
| Answer | Implemented | Directory/Git sources, extractive or model drafts, citations, review, publication and watch | Source scope, audience and answer quality need target-system validation |
| Query | Implemented | Reviewed OpenAPI GET and read-only POST operations, current-user identity, roles and field projection | POST needs explicit read-only review and flat scalar parameters; SaaS enforces object access; GraphQL is not supported |
| Act | Implemented | Registered actions, exact previews, explicit confirmation, reauthorization and receipt reconciliation | SaaS implements transactional idempotency; no arbitrary browser control or autonomous multi-step writes |
| Investigate | Partial | Business failure events and page previews, HTTP/Loki/Prometheus/Tempo, durable investigations, incident deduplication and recovery, and attested deployment records | Requires real sources and trusted scope labels; missing or out-of-scope traces return unknown or are rejected; correlated evidence is not proof of root cause |
| Handoff and learn | Partial | Persistent conversations, ticket assignment, customer follow-ups, operator replies, resolve/reopen and internal knowledge drafts | Requires matching migrations and scoped operator access; restores saved text and historical references without replaying actions; external ticket systems need adapters and acceptance |
| Self-host | Partial | Source installation, setup, floating/inline/standalone entry, diagnostics, backup and isolated restore | Single-host integration preview; official images/npm packages, distributed quotas and HA are not shipped |
| Code repair | Planned | Planned: engineering evidence handoff, fix proposals, isolated verification and draft PRs | No automated code changes, merge or production deployment |

[//]: # (agent18:capabilities:end)

“Implemented” means the repository provides implementation and validation paths—not that your deployment is accepted. Use the [target-system acceptance report](docs/reference/integration-acceptance.md) to check real identities, user/tenant isolation, model quality, business writes, and failure handling.

## Documentation and development

| Task | Start here |
| --- | --- |
| Run, deploy, and maintain | [Installation](docs/guides/installation.md) · [Operations and recovery](docs/guides/operations.md) · [Security](SECURITY.md) |
| Integrate an existing product | [Integration brief](INTEGRATE.md) · [Identity and SDK](docs/guides/integration.md) · [Acceptance](docs/reference/integration-acceptance.md) |
| Manage knowledge and support | [Knowledge](docs/guides/knowledge.md) · [Operator workspace](docs/guides/support-workspace.md) · [Knowledge governance and business analytics](docs/guides/advanced-workflows.md) · [Observability](docs/guides/observability.md) |
| Understand and extend | [Runtime overview](docs/overview/agent18-0.8-integration.md) · [API and SDK](docs/reference/api.md) · [Handbook](docs/README.md) |
| Contribute | [Contributing](CONTRIBUTING.md) · [Roadmap](docs/planning/mvp-roadmap.md) · [Changelog](CHANGELOG.md) |

```sh
pnpm check          # Formatting, docs, build, tests, and local release checks
pnpm run doctor     # Diagnose a configured local instance
```

Choose database, recovery, and end-to-end tests using the [contribution guide](CONTRIBUTING.md). Some tests pause demo services or change synthetic data; do not point them at production.

Release and capability blocks are maintained in `docs/release.json`. After changing the manifest, run `pnpm docs:sync` and `pnpm docs:check`. Keep the generation markers in both READMEs.

## License

Core is [Apache-2.0](LICENSE); the Web SDK is [MIT](packages/web-sdk/LICENSE). Access to knowledge sources and business APIs remains governed by the respective systems.
