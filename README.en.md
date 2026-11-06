# Research Foundry

[简体中文](README.md) · **English**

**From a research question to a manuscript draft with evidence you can trace.**

Research Foundry is a locally hosted workspace for research with multiple AI models. Set the question and the acceptance criteria. A controller breaks down the work, assigns tasks, and resolves disagreements. Each round leaves behind deliverables, reasoning, and open questions you can revisit days later.

[Quickstart](#quickstart) · [Model setup](#models-and-roles) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

## From research question to manuscript

Suppose you're comparing two algorithms and want to know whether an observed gain comes from the method itself or from differences in the evaluation setup.

1. **Give the work a home.** Create a project and use separate sessions for methods, evaluation design, and writing. You can move existing sessions into the project, with each session keeping its own materials and memory.
2. **Check different angles in parallel.** Ask the controller to assign one worker to audit the evaluation protocol and another to map the existing evidence. As reports come in, the controller can accept them, request revisions, or dispatch follow-up work. Expand the round to see how a conclusion was reached.
3. **Set a goal the team can finish.** For example, “Deliver a comparison table with the source of each claim and every remaining evidence gap.” Goal mode continues across rounds, shows when it will retry or where it needs input, and can pick up from saved state after a restart.
4. **Carry the evidence into the draft.** Hover over the CCF-A progress chart to see when an assessment changed and what prompted the change. In manuscript review, turn session materials into sectioned Chinese and English drafts, check reported numbers against the evidence, and send reviewer comments into a follow-up round.

## What comes with the workspace

| Capability | What you can do |
| --- | --- |
| Multi-model collaboration | Choose your own controller, workers, and reviewers. Run tasks in parallel, cross-review reports, and reuse cached reviews for the same contribution and review configuration. |
| Research continuity | Keep projects, standing directives, round notes, and long-term memory together. Collapse long histories or expand individual reports and disagreements when you need the details. |
| Traceable progress | Read CCF-A progress against actual assessment times. Hover for the round, rationale, and blockers behind the controller's assessment. |
| Manuscript review | Generate sectioned bilingual drafts, flag numbers without a match in the materials, and attach comments to specific passages for revision. |
| Providers and quota | Configure multiple providers for a model lane, switch the preferred provider, and opt into read-only quota queries for LMU AI or OpenRouter. |
| Web and CLI | Use the command workspace for ongoing projects or the roundtable for focused discussions. A CLI and an optional DSH plugin are also available. |

## Quickstart

Use Node.js 22 or newer. The standalone server uses Node's built-in modules and has zero runtime package dependencies. Download or clone the repository, enter its root directory, and launch a demo with mock responses.

```bash
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm start
```

Open the [command workspace](http://127.0.0.1:8787/.research-foundry/command), create a project and a session, then send a sample question. The demo uses fixed example output and makes zero model-service calls.

### Connect your models

The default workflow has one controller and one worker. Set each lane's compatible API base URL and model ID in your shell. Set the corresponding API-key environment variable if your provider requires one.

```bash
export FOUNDRY_CONTROLLER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_CONTROLLER_MODEL='YOUR_MODEL_ID'
export FOUNDRY_WORKER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_WORKER_MODEL='YOUR_MODEL_ID'
# Authenticated endpoints use FOUNDRY_CONTROLLER_API_KEY / FOUNDRY_WORKER_API_KEY
npm start
```

See [.env.example](.env.example) for the variable names. The service reads the shell environment directly. Goal mode and multi-round review can increase API usage. Start with one manual round to check your setup.

## Models and roles

Copy the [example config](examples/config.example.json) to `config.json` in your runtime directory and restart the service. The default runtime directory is `~/.dsh/research-foundry/`. Set `FOUNDRY_HOME` to use a different private directory.

| Lane kind | Configuration |
| --- | --- |
| `openai` | Use a Chat Completions-compatible base URL such as `http://localhost:1234/v1`. Keyless local endpoints are supported. |
| `anthropic` | Use the service root URL. The adapter appends `/v1/messages`. |
| `codex` | Install and sign in to a compatible Codex CLI. Configure `bin` and optionally `model` and `reasoning`. |
| `deepseek` | Available for existing configurations. New Chat Completions-compatible setups can use `openai`. |

The `lanes` object defines the full roster. Use `protocol.controller`, `protocol.workers`, and `protocol.reviewers` to assign roles. Set `reviewRounds` and `reviewPassRatio` to adjust the review panel. The pass threshold rounds up from reviewers × rounds × pass ratio. A passing review requires all planned calls to succeed. Keep lane IDs stable when resuming existing sessions.

### Provider switching and quota

A lane can have a `providers` array. Give each provider a unique `id`, compatible `kind`, `baseUrl`, `model`, and `apiKeyEnv` if required. The `active` field sets the preferred provider. Switching in the workspace applies for the current server process. A retryable error can send the same prompt to another enabled provider on that lane, so use providers authorized for the same materials.

Set `"balance": true` on a lane or provider to show the current key's quota where supported. [LMU AI](https://docs.lmuai.ai/docs/api/balance) reports the key's available quota. [OpenRouter](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) reports key usage and any key-specific limit. Use the OpenRouter dashboard for account-wide balance.

## Data and runtime boundaries

Session history, memory, and artifacts are stored locally. Materials and explicitly configured knowledge or skill content can become part of prompts sent to your selected model providers. Use `knowledge.extraSources` for approved sources, `FOUNDRY_SKILLS_DIR` for an optional skills directory, and `memory.obsidianDir` for an optional export destination. Environment keys are used at runtime and kept out of generated configuration.

Keep the unauthenticated HTTP service on loopback, its default. The status listener uses the next port and serves session information. Keep the runtime directory outside the repository.

Research Foundry coordinates discussion, review, and writing. Its Codex adapter runs in a read-only sandbox in a temporary directory. Training, GPU scheduling, and external execution require separate integration. Model reviews and progress scores are inputs to human judgment.

## Development

```bash
npm test
npm run check:privacy
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm run mock
```

- [Engine](lib/engine/) contains the orchestration, model adapters, and persistence.
- [Web UI](lib/gui/) serves the command workspace, manuscript review, and roundtable.
- [CLI help](lib/CLI_HELP.txt) covers local commands.
- [Public release notes](docs/PUBLIC_RELEASE.md) describe the source export and its privacy checks.

## License

[MIT](LICENSE). Model providers, optional integrations, and externally supplied materials have their own terms.
