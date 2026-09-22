# Changelog

## 0.8.0 — SaaS Integration and Semantic Context

- Add explicitly reviewed read-only POST queries with fixed paths, typed scalar JSON bodies, current-user authorization and response projection; OpenAPI auto-import remains GET-only.
- Add an Owner registration flow that validates POST definitions and keeps new entries disabled until enabled and applied.
- Add bounded SDK business success/failure events, route context, expiry, object-change cleanup and explicit context snapshots.
- Guide recent unresolved failures into a reviewable case report; freeze preview context and allow customers to omit both semantic and captured page context.
- Persist submitted events in scoped cases, show them to local operators and correlate investigation logs using the reported failure trace ID.
- Extend the synthetic SaaS and real Loki/Prometheus acceptance journey. Existing GET configurations remain compatible; no new database migration.

See the [0.8 overview](docs/overview/agent18-0.8-integration.md) and [semantic context guide](docs/guides/semantic-context.md). The bullets above describe the initial 0.8 delivery; subsequent source changes below keep the 0.8.0 integration-preview version and require their migrations and rebuilt services.

### Current source workflows and integration review

- Deliver independent staff accounts with project/tenant authorization, persistent conversation text and historical references, ticket assignment, public/internal replies, SLA calendars and retention/deletion replay.
- Add fixed knowledge provenance, topic-based generation, separate customer drafts, candidate evaluation and semantic review, publication sets and private Git credential bindings.
- Add scoped Tempo evidence, deployment records, signed ticket synchronization, service-authorized business analytics, registered Playbooks and scheduled reports. Apply migrations through 036; see [workflow evidence](docs/development/round17-product-workflows.md).
- Align the integration brief, runtime overview, handbook and target-system acceptance checklist with these implementations; document container source paths, staff bootstrap, optional integrations and the limits of reusing a multi-project instance.
- Reject late SDK tokens and responses after client destruction so identity changes cannot continue an old request through a custom transport.
- Remove forced database termination from operator test teardown to avoid racing closing PostgreSQL clients; retain errors for leaked connections and include isolated backup validation in CI.

Remote staff SSO, official package/image distribution, HA and automatic code repair remain outside this source delivery. External SaaS acceptance is still required; see the [integration review](docs/development/round18-integration-review.md).

### Documentation and review alignment

- Clarify the Chinese and English product introduction around answers, confirmed business actions and runtime evidence, with explicit deployment and capability limits.
- Synchronize the handbook, contribution guide and public roadmap; add review findings and acceptance gates for future integrations.
- Add a versioned capability manifest and `docs:check` / `docs:sync` for current documentation blocks, changelog presence and local links; include checking in CI through `pnpm check`.
- Log the actual listening address and restrict demo issuer CSP connections to the locally configured synthetic console.

## 0.7.0 — Support and Operations

- Capture bounded page text, errors and optional screenshot previews for customer reports; private regions and form values are excluded. The host must validate redaction on its real pages.
- Connect Owner-configured HTTP, Loki and Prometheus sources through a read-only engineering provider. Persist case investigation jobs, scoped reports and customer-safe summaries.
- Schedule durable inspections, merge recurring incidents, acknowledge and resolve healthy recoveries, and create internal knowledge drafts for review.
- Add a real Loki/Prometheus demo and isolation, lease recovery, unknown-result and incident lifecycle validation.
- Use current entity context to prefill explicitly referenced business arguments; context remains a hint, never an authorization source.

Upgrade: back up before applying migration `009_operations.sql`; recreate Core and Worker after configuration changes. Monitoring is disabled until configured. Screenshot capture is optional and off by default. Full trace correlation, proven root cause, remote operator SSO and code repair remain unimplemented. See the [0.7 overview](docs/overview/agent18-0.7-operations.md).

## 0.6.0 — Core Foundation

- Add a repository-to-SaaS integration task brief and target-system acceptance report, linked from both READMEs and the built-in handbook.
- Recreate file-mounted runtime consumers and run migrations in a fresh container on deployment; verify config-only updates and restored database activation without recreating PostgreSQL.
- Generalize Context, Evidence and RunStep; migrate historical citations and pin queued Run definitions.
- Register and review Providers/Tools with schema checks and three-state OPA authorization; preserve read-only retries and explicit business confirmation.
- Separate capability domains from transport and verify a synthetic log provider through the complete Case runtime.
- Document migration, integration contracts and the boundary between implemented L1–L3 and future L4/L5.

### Conversational entry

- Replace floating and inline feature tabs with one continuous conversation, an anchored composer, contextual choices, query results, citations and explicit action confirmation cards.
- Add scoped conversation routing, typed parameter follow-ups and bounded user-message context. Model-assisted planning falls back to deterministic guidance and never executes business operations itself.
- Keep support handoff, case replies and progress inside the same conversation.

## 0.5.0 — 2026-09-15

A complete source-to-service integration preview.

- Import OpenAPI 3.0/3.1 GET candidates, review roles and projected fields, query independent SaaS APIs using the current user's token.
- Add a persistent local operator workspace: deployment health, project identity editing, query/bridge configuration and customer inbox.
- Complete support conversations with scoped, idempotent messages, local operator replies, resolution and reopening. Late Run results preserve customer resolution.
- Extend floating, inline and standalone customer experiences with business reads and case progress/replies.
- Add knowledge watch with content/configuration signatures, unchanged-build reuse, draft-only updates and per-project saved configurations.
- Rank focused knowledge using title matches and length normalization after scope filtering.
- Use explicit `pnpm run setup` and `pnpm run doctor` to avoid collisions with package-manager commands.
- Serve a versioned documentation site and OpenAPI customer contract, with an exportable SDK/API checksum manifest.
- Add diagnostics, PostgreSQL/config/SQLite backup, actual isolated restore verification, new-database restore and explicit activation.
- Separate the demo issuer into a Compose profile; document real project preparation, HTTPS proxying and deployment maintenance.
- Add clean-install journey, connection/authorization/conversation tests, English introduction and contribution/issue/PR guidance.

Upgrade: back up first. Migration `005_case_conversation.sql` adds scoped messages and the resolved Case state. Recreate Core after configuration writes and recreate both Core/Worker after database activation. Provider protocol versions remain unchanged.

## 0.4.0

Five-step setup wizard, style-isolated floating/inline assistant and standalone support page with scoped identity handoff. Real local source build/review/publish workflow and explicit business confirmation UX.

## 0.3.0

Directory/Git knowledge ingestion, model-backed structured article generation and cited answers, versioned publication, SaaS business bridge with previews and idempotent receipts.

## 0.2.0

Persistent Case/Run lifecycle, cancel/retry/recovery, outbox dispatch, scoped evidence and audit. Foundation uses PostgreSQL FORCE RLS and OPA default-deny policy.
