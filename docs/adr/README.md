# Architecture Decision Records

Durable, load-bearing decisions — one per file, stable ID, terse on *what* /
detailed on *why*, with `Applies to` globs and a `Verify` command. Cite an ADR
by ID from other docs instead of restating the decision (each fact lives once).

| ID | Decision |
|----|----------|
| [ADR-AGENT-001](./ADR-AGENT-001-opaque-transcript-storage.md) | Browser-agent chat transcripts are stored as opaque JSON, not the server `Message` model. |
| [ADR-AGENT-002](./ADR-AGENT-002-tool-confirm-gate-and-result-contract.md) | Off-board tool confirm gate + unified `ToolFailure` result contract. |
| [ADR-AGENT-003](./ADR-AGENT-003-service-resolution-and-metering.md) | Per-capability service resolution (BYOK/managed/off) + one `X-Run-Id` per run = one metered unit. |
| [ADR-SYNC-001](./ADR-SYNC-001-offline-first-relay.md) | Offline-first: the client owns conflict resolution (rebase-LWW); the backend is a sequencer + relay. |
| [ADR-SEARCH-001](./ADR-SEARCH-001-local-doc-qa-bm25.md) | Local document Q&A: managed OCR, offline Orama BM25 index, no vector store (D2). |
| [ADR-DESKTOP-001](./ADR-DESKTOP-001-rusqlite-local-storage.md) | Desktop storage is rusqlite (single connection, atomic `sql_tx`), not a pooled SQL driver. |
| [ADR-DESKTOP-002](./ADR-DESKTOP-002-byok-relay-and-remote-path.md) | Desktop: BYOK goes direct via plugin-http (offline); managed + synced ride a build-time server URL (`API_URL` from `VITE_API_URL`). |
| [ADR-DESKTOP-003](./ADR-DESKTOP-003-distribution-and-unsigned-install.md) | Desktop distribution: tagged GitHub Release; terminal install is prompt-free even unsigned (ad-hoc signed, no quarantine/MOTW). |
| [ADR-BILLING-001](./ADR-BILLING-001-oss-mode-when-billing-inactive.md) | Billing-inactive deploys run full-OSS (plan `plus`, no limits); one plan resolver, consumed by the frontend. |
| [ADR-APPLET-001](./ADR-APPLET-001-declarative-inline-eval-free.md) | Applets are declarative, inline-rendered, eval-free widgets; the bounded interpreter is the sandbox. Legacy mini-app frozen, no migration. |
