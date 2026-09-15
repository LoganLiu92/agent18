# Changelog

## 0.6.0 — Core Foundation

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
