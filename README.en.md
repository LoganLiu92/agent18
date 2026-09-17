# agent18

**AI support that can answer, act, and investigate.**

Agent18 is an open-source support agent for SaaS products. Connect your documentation, code, model API and current-user identity. Customers get cited answers, query their business data, confirm registered actions and report failures from one conversation. Your support team follows up with runtime evidence and turns resolutions into reviewed knowledge.

- **Answer** with published knowledge and user-scoped business data.
- **Act** through registered APIs, explicit confirmation and verifiable receipts.
- **Investigate** with page context, HTTP health, Loki logs and Prometheus metrics.

**Integrating an existing product? Start with the [integration task brief](INTEGRATE.md)** (Chinese). It maps responsibilities across repositories, defines staged outcomes, and includes a task prompt and [acceptance report template](docs/reference/integration-acceptance.md) for your target system.

[//]: # (agent18:release:start)

Current version: **0.8.0 integration preview**. See the [runtime overview](docs/overview/agent18-0.8-integration.md); source-based, single-host deployment.

[//]: # (agent18:release:end)

Built for SaaS teams with existing authentication, business APIs and product knowledge who want to self-host support. See the [capability roadmap](docs/planning/mvp-roadmap.md) and [observability guide](docs/guides/observability.md) for integration requirements and limits.

## Run locally

Requires Node 24.14.x, pnpm 11.19.0 and Docker Compose v2. Git sources use the host's existing read permissions. Official images and npm SDK packages are not published yet; these commands build from source and start a local synthetic SaaS demo.

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

Open `http://localhost:4321/setup` and enter the owner access code printed in your terminal. Connect a project, optional model, knowledge sources and website. After setup, the operator workspace becomes the default view.

Try the synthetic SaaS at `http://localhost:4319/example`. Its floating assistant can read scoped orders, preview and change the current user's notification preference, verify persisted state, and submit support cases. The same interface supports inline embedding and a standalone support page opened from the SaaS.

## AI reasons. Your system remains in control.

A business write follows: registered capability and schema → policy → exact preview → user confirmation → identity, permission and revision checks → SaaS execution → receipt reconciliation.

The model proposes registered actions and arguments. Agent18 forwards the current user's short-lived identity to a fixed API. Your SaaS rechecks object access and commits the mutation and idempotent receipt in one transaction. Uncertain delivery stays unverified while Agent18 checks the receipt. See the [business action contract](docs/guides/business-actions.md).

## What is available

[//]: # (agent18:capabilities:start)

| Capability | Status | Available | Requirements and limits |
| --- | --- | --- | --- |
| Answer | Implemented | Directory/Git sources, extractive or model drafts, citations, review, publication and watch | Source scope, audience and answer quality need target-system validation |
| Query | Implemented | Reviewed OpenAPI GET and read-only POST operations, current-user identity, roles and field projection | POST needs explicit read-only review and flat scalar parameters; SaaS enforces object access; GraphQL is not supported |
| Act | Implemented | Registered actions, exact previews, explicit confirmation, reauthorization and receipt reconciliation | SaaS implements transactional idempotency; no arbitrary browser control or autonomous multi-step writes |
| Investigate | Partial | Semantic business failure events and page previews, HTTP/Loki/Prometheus, durable investigations, incident deduplication and recovery | Requires real sources and trusted labels; full trace correlation and proven root cause are not implemented |
| Handoff and learn | Partial | Persistent cases, follow-ups, local operator replies, resolve/reopen and internal knowledge drafts | Ordinary chat resets on reload; remote operator SSO, assignment and external ticket sync are not implemented |
| Self-host | Partial | Source installation, setup, floating/inline/standalone entry, diagnostics, backup and isolated restore | Single-host integration preview; official images/npm packages, distributed quotas and HA are not shipped |
| Code repair | Planned | Planned: engineering evidence handoff, fix proposals, isolated verification and draft PRs | No automated code changes, merge or production deployment |

[//]: # (agent18:capabilities:end)

Implemented means the repository includes runnable behavior and validation paths. Your real identity, data, model quality and production behavior still need [target-system acceptance](docs/reference/integration-acceptance.md).

## What you integrate

The 0.8 preview adds explicitly reviewed read-only POST queries and bounded host business events. `client.emit` can attach operation/error/trace hints to a reviewable report; context expires, resets when the current object changes, and can be omitted before submission. See [semantic context](docs/guides/semantic-context.md) and the [0.8 overview](docs/overview/agent18-0.8-integration.md).

1. **Identity:** Your authenticated backend issues a short-lived Ed25519 Support Token. Project, tenant, user and roles are derived from a trusted session. Agent18 verifies signatures and enforces scoped PostgreSQL RLS.
2. **Knowledge:** Import directories or Git. Build extractive or model-generated drafts with file/line citations. Review and publish. `knowledge watch` builds changed drafts without automatically publishing them.
3. **Business reads:** Import a bounded OpenAPI 3.0/3.1 GET subset. Operations start disabled; review roles and projected response fields. Your API revalidates the current user's permissions.
4. **Business actions:** Implement prepare/execute/status at a fixed SaaS endpoint. The user confirms an exact preview; your backend commits business data and an idempotent receipt together. Uncertain delivery is reconciled without resending writes.
5. **Support:** Customers report, follow up, view progress, receive operator replies, resolve and reopen their own cases.

Agent18 does not replace your login system or business database. Repository access and a model key do not grant business permissions. Your SaaS remains responsible for live authorization and object ownership.

## Embed

```js
import { Agent18, mountFloatingAssistant }
  from 'https://support.example.com/sdk/agent18.js';

const client = new Agent18({
  baseUrl: 'https://support.example.com',
  projectKey: 'your-saas',
  getToken: async () => {
    const response = await fetch('/api/support-token', { method: 'POST' });
    if (!response.ok) throw new Error('Login required');
    return (await response.json()).token;
  },
});
const assistant = mountFloatingAssistant(client, { title: 'Product assistant' });
// On logout/user change: assistant.destroy(); client.destroy();
```

Also available: `mountAssistant(container, client)` and `openSupportPage(options)`. The browser SDK is framework independent; optional UI uses Shadow DOM and collects bounded report context without cookies or form values; optional screenshots require configuration and a report preview. Current built-in UI and most detailed guides are Chinese.

## Operate and contribute

Built-in docs: `/docs`. Machine-readable contract: `/openapi.json`.

```sh
pnpm check
pnpm run doctor
pnpm knowledge watch 300
pnpm backup
pnpm backup:verify .local/backups/YOUR_BACKUP
```

Backups contain sensitive configuration and stay local. Restore verification creates and removes a fresh isolated database. A retained restore can be explicitly activated; existing databases are not overwritten.

Default ports bind to loopback. The synthetic identity issuer is in the demo profile. See the [installation guide](docs/guides/installation.md) before public deployment; expose only Core behind HTTPS, keep the operator service local, and use your real SaaS identity.

See [the handbook](docs/README.md), [runtime overview](docs/overview/agent18-0.7-operations.md), [roadmap](docs/planning/mvp-roadmap.md), [review and priorities](docs/planning/review-and-priorities.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md). Core is Apache-2.0; the browser SDK is MIT.

## Core Foundation in 0.6

Context, Evidence, RunStep, Provider/Tool registries and three-state policy decisions now support domain-neutral read workflows. L1 knowledge, L2 identity and L3 confirmed business actions remain implemented; 0.7 adds HTTP / Loki / Prometheus evidence and inspection reports; full trace correlation, proven RCA and code fixes remain roadmap work. See the [0.6 review and migration guide](docs/overview/agent18-0.6-core.md) and [registry contracts](docs/reference/providers.md). Public npm SDK packages and official images are not published yet.

## Real monitoring demo

After `pnpm demo:start`, run `pnpm observability:demo` and `pnpm test:observability`. Optional Compose profiles run pinned Loki and Prometheus images with synthetic business errors and recovery. Production deployments configure existing monitoring endpoints, scopes and read-only credentials in the Owner workspace. Page capture defaults to bounded text/error context; screenshots are off by default. Mark sensitive regions with `data-agent18-private` and review the capture before submission.
