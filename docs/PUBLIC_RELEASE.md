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

## 0.2.0 — configurable model roster

The controller, workers and reviewers now use arbitrary configured lane IDs. Defaults are two generic roles with no preset endpoint or model. OpenAI-compatible Chat Completions, Anthropic-compatible Messages and optional Codex CLI are transport choices, independent of roles. Legacy provider IDs remain compatible when explicitly configured.

The UI and review thresholds follow the actual roster. Review caches include the reviewer models/endpoints and settings. Incomplete reviews cannot pass. A full custom roster replaces the defaults; keep legacy IDs for existing sessions or start a new session after changing the roster.

Validation: eight offline regression tests, including 2/3/4 participants and custom IDs, controller routing, dispute resolution, dynamic review thresholds/cache isolation and a stubbed generic HTTP request. A browser smoke with four named example participants completed a mock round and displayed the expected 4-by-2 review grid without console errors. No live provider capability or quality claim is inferred from mock tests. The running private installation was not modified.

The source installation's subsequent UI update was merged by a three-way comparison against the initial source export: collapsible rounds, older-round grouping, process visibility, latest-round controls and follow-latest behavior are retained alongside the configurable roster. Source installation files remain untouched.

Browser verification also reproduced and fixed a lazy-history issue: opening an older-round group in an idle session left it empty because no polling redraw occurred. The group now renders its children immediately; detached toggle events are ignored.
