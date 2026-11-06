# JoFoundry

![JoFoundry manga cover with three investigators reviewing evidence at a workbench](assets/readme/hero.webp)

![LOCAL WORKSPACE, EVIDENCE REVIEW, NODE.JS 22+](assets/readme/product-strip.svg)

[简体中文](README.md) · **English**

**A research workspace that keeps the question, evidence, decision, and next step together.**

JoFoundry is a locally hosted workspace for research with multiple AI models. You define the question and acceptance criteria. A controller assigns work and adjudicates findings. Workers inspect evidence, look for counterexamples, and challenge each other's reports. Pick up the study from saved state and carry reviewed evidence into English and Chinese drafts.

[Quickstart](#quickstart) · [Features and outcomes](#features-and-outcomes) · [Session walkthrough](#session-walkthrough) · [Connect models](#connect-models) · [Changelog](CHANGELOG.md) · [MIT](LICENSE)

## Quickstart

Use **Node.js 22+**. The standalone server uses Node's built-in modules.

```bash
git clone https://github.com/Xiaoqian-Zhang-Shawno/JoFoundry.git
cd JoFoundry
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm start
```

1. Open the [command workspace](http://127.0.0.1:8787/.research-foundry/command), create a project, and select the evidence-first option (`证据优先`) in the workflow selector (`协作流程`) for the new session.
2. Send a sample question: “Review a synthetic benchmark comparison. Check whether the splits and metrics are comparable, and list the evidence and missing controls separately.”
3. Expand the round to inspect the reports and ruling. Open the research track tab (`主线`) for the stage, decision, and next trigger. Submit missing evidence in that session to resume a waiting goal.
4. With configured models, select the same session in [manuscript review](http://127.0.0.1:8787/.research-foundry/review) to generate and review a draft.

Mock mode uses synthetic responses and makes no model-service calls. The status listener defaults to port `8788`. If the default ports are occupied, append `-- --port 18787 --status-port 18788` and open the workspace on port `18787`.

The evidence workflow covers problem definition, minimal checks, iteration, full validation, and results audit. Each round records an advance, revision, candidate rejection, or wait decision. A waiting goal keeps its objective until you submit more evidence. Existing sessions retain their workflow.


## Features and outcomes

When a study spans several chats, it is easy to lose track of who checked a claim, which source they used, and what would change the decision. JoFoundry keeps reports, disagreements, rulings, and next triggers in the original project and round.

[![Research question and criteria → project assignments → parallel reports and cross-review → ruling and evidence record → next decision or bilingual draft review.](assets/readme/workflow-en.webp)](assets/readme/workflow-en.webp)

[Editable source (draw.io)](assets/readme/workflow-en.drawio)

<details>
<summary>Expand the Mermaid diagram</summary>

```mermaid
flowchart LR
    Q["Question and acceptance criteria"] --> P["Project and assignments"]
    P --> E["Parallel reports and cross-review"]
    E --> D["Ruling and evidence record"]
    D --> N["Advance, revise, reject, or wait"]
    D --> W["Bilingual draft and passage review"]
```

</details>

| Feature | What you can see or control |
| --- | --- |
| **Projects and sessions** | Organize methods, validation, and writing as separate sessions, each with its own objective, materials, instructions, history, and open work. |
| **Multi-model collaboration** | Configure controller, worker, and reviewer roles. Inspect reports, revisions, cross-reviews, and rulings in the round that produced them. |
| **Evidence-first handoffs** | Record the stage, evidence, decision, and next trigger. Resume at a specific point or wait in the original session for missing evidence. |
| **Resumable goals** | Set completion criteria and see the reasons for progress or blockers. Pause or resume automatic continuation, stop a round, and recover persisted state after restart. |
| **Bilingual manuscript review** | Generate sectioned English and Chinese drafts, flag numbers without a match in session materials, and track comments on specific passages. |
| **Configurable providers** | Use compatible local or remote APIs or the Codex CLI. Configure preferred providers, fallback, and optional quota lookups. |

### Verified workflow behavior

Both modes received the same scripted decision while evidence was missing. In this controlled replay, **standard mode opened 1 automatic follow-up round and evidence-first mode opened 0**. The waiting session retained its objective, decision, and next trigger after restart. A wrong-project submission returned HTTP 409 and left the rounds and pending queue intact. Evidence from the matching project opened T2 in the original session.

```bash
node scripts/validate-evidence-handoff.mjs
npm test
```

The replay uses synthetic inputs and local HTTP, with zero external model calls. The 14 offline regression tests also cover recovery, provider routing, and number-trace hints in bilingual drafts. The replay measures workflow behavior in a specified scenario. Researcher time, scientific quality, and model performance await controlled evaluation. [Results and reproduction](docs/EVALUATION.md) · [Regression tests](tests/) · [Release scope](docs/PUBLIC_RELEASE.md)

## Session walkthrough

| Stage | What you provide | What to inspect |
| --- | --- | --- |
| Define | A comparison, acceptance criteria, and available evidence | Whether splits, metrics, and controls answer the same question |
| Assign and review | Materials and constraints | Worker reports, counterexamples, disagreements, and the controller ruling |
| Act on the ruling | New evidence or a decision on a candidate | Whether to advance, revise, reject, or wait, and what triggers another round |
| Draft and review | Checked materials and target sections | Section drafts, number-trace flags, and human comments |

> [!TIP]
> Run a synthetic round first. Expand its reports, cross-review, and ruling to see how each decision traces back to evidence before adding real materials.

Separate sessions keep parallel questions organized. When evidence arrives later, keep the objective and next trigger in the original session. Open manuscript review for that same session to draft from the reviewed materials.

## Connect models

The default setup has one controller and one worker. Set compatible endpoints and model IDs in your shell, then verify one short manual round.

```bash
export FOUNDRY_CONTROLLER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_CONTROLLER_MODEL='YOUR_CONTROLLER_MODEL'
export FOUNDRY_WORKER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_WORKER_MODEL='YOUR_WORKER_MODEL'
npm start
```

- **Authentication.** Set `FOUNDRY_CONTROLLER_API_KEY` or `FOUNDRY_WORKER_API_KEY` if required. See [.env.example](.env.example).
- **Model interfaces.** Use a Chat Completions-compatible URL for `openai`, a service root URL for `anthropic`, or a signed-in compatible CLI for `codex`.
- **Multiple roles.** Save the [example config](examples/config.example.json) as `config.json` in the runtime directory. Use `protocol.controller`, `protocol.workers`, and `protocol.reviewers` to set roles. Configure distinct worker lanes to see cross-model review.
- **Providers.** Use `providers` and `active` to select a preferred provider. Fallback may send the same prompt to another configured provider. Quota lookups are opt-in.

Sessions, memory, and artifacts are stored locally. The default runtime directory is `~/.dsh/research-foundry/`. Use `FOUNDRY_HOME` to choose another directory. Selected materials and knowledge sources can enter provider prompts. The unauthenticated web UI binds to loopback by default. The public Codex adapter uses a read-only sandbox. Training, GPU scheduling, and remote execution require separate integration.

## Operating limits and troubleshooting

| Symptom | First check |
| --- | --- |
| A session is missing | Check `FOUNDRY_HOME`. The quickstart's `mktemp -d` creates a fresh workspace. |
| A goal is waiting | Read the ruling and next trigger in the research track. Add the required evidence to the original session. |
| A model lane fails | Check the endpoint, model ID, credential environment variable, and active provider. Try a short request. |
| A draft number is flagged | Locate the original table or experiment record in the session materials and verify it during human review. |

> [!IMPORTANT]
> Review the selected materials and provider fallback settings before enabling remote models. Runtime state stays local. Model requests can send selected materials to a configured provider.

## Development and verification

```bash
npm test
npm run check:privacy
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm run mock
```

[Engine](lib/engine/) · [Web UI](lib/gui/) · [CLI help](lib/CLI_HELP.txt)

The evidence workflow draws inspiration from the research iteration and review described in [ScientistTwo](https://arxiv.org/abs/2609.19644). Researchers make the final decisions in JoFoundry.
