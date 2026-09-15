# agent18

An open-source assistant for existing SaaS products. Connect code and documentation, bring your own model, reuse your users' identity, and embed knowledge answers, business queries, confirmed actions and support conversations in your website.

**Integrating an existing product? Start with the [integration task brief](INTEGRATE.md)** (Chinese). It maps responsibilities across repositories, defines staged outcomes, and includes a task prompt and [acceptance report template](docs/reference/integration-acceptance.md) for your target system.

**0.6.0 integration preview.** This release connects the adoption and operation workflow: setup wizard, local operator workspace, three customer entry modes, versioned knowledge, OpenAPI reads, delegated actions, support replies, diagnostics and backup/restore. Runtime investigation and autonomous code repair are not implemented.

## Run locally

Requires Node 24.14.x, pnpm 11.19.0 and Docker Compose v2. Git sources use the host's existing read permissions.

```sh
git clone https://github.com/LoganLiu92/agent18.git
cd agent18
pnpm install --frozen-lockfile
pnpm start
```

Open `http://localhost:4321/setup` and enter the owner access code printed in your terminal. Connect a project, optional model, knowledge sources and website. After setup, the operator workspace becomes the default view.

Try the synthetic SaaS at `http://localhost:4319/example`. Its floating assistant can read scoped orders, preview and change the current user's notification preference, verify persisted state, and submit support cases. The same interface supports inline embedding and a standalone support page opened from the SaaS.

## What you integrate

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

Also available: `mountAssistant(container, client)` and `openSupportPage(options)`. The browser SDK is framework independent; optional UI uses Shadow DOM and never inspects host cookies or page contents. Current built-in UI and most detailed guides are Chinese.

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

See [the handbook](docs/README.md), [architecture and implementation overview](docs/overview/agent18-0.5-overview.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md). Core is Apache-2.0; the browser SDK is MIT. Public npm packages and container images are not prerequisites for source-based deployment.

## Core Foundation in 0.6

Context, Evidence, RunStep, Provider/Tool registries and three-state policy decisions now support domain-neutral read workflows. L1 knowledge, L2 identity and L3 confirmed business actions remain implemented; real runtime connectors, RCA and code fixes remain roadmap work. See the [0.6 review and migration guide](docs/overview/agent18-0.6-core.md) and [registry contracts](docs/reference/providers.md). Public npm SDK packages and official images are not published yet.
