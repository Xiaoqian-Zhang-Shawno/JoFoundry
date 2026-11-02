# Public release review

Date: 2026-11-02

Scope: standalone source export with a new Git history. The live installation and its data were not modified.

Excluded: screenshots, runtime configuration, environment files containing values, sessions, research materials, prompts/results from real runs, logs, account data, caches, backups, restart helper and existing Git history.

Public-version changes:

- Removed automatic credential discovery and third-party login-token exchange.
- Environment keys remain in memory; diagnostic views redact full keys.
- Removed personal project/Obsidian paths and project-specific example prompts.
- Knowledge sources and skills now require explicit selection.
- Removed external-app account/quota discovery and personal Codex-log scanning; local call statistics remain.
- Generic research mission; configurable model IDs and Codex binary.
- Private runtime directory override, ignore rules, offline regression checks and privacy scanner.

Limitations: heuristic scans cannot prove absence of every kind of private information. Real model calls, optional DSH integration and every frontend interaction have not been validated by the offline checks. Multi-model scores are not independent peer review. No private operational execution bridge is included.

Validation performed on release copy:

- Three Node regression tests passed.
- All JavaScript modules passed `node --check`.
- Offline roundtable CLI completed successfully.
- Local HTTP smoke passed for the controller page, empty default knowledge sources and isolated status endpoint.
- Heuristic privacy scanner passed for 33 release files; additional literal credential, JWT, address and chat-identifier checks found only documented placeholders and test fixtures.
- Real model calls and optional DSH integration were not exercised.

Commit identity uses a GitHub noreply address; no original runtime data or prior Git history is included.
