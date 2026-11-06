# JoFoundry evidence handoff evaluation

This is a **controlled software replay** of one designed scenario. Both workflows use the same JoFoundry build, synthetic task, and scripted loopback provider. The controller returns a request to continue alongside an evidence decision of wait while the required result is missing. The standard workflow follows the continuation request. The evidence workflow can interpret and persist the wait decision.

## Reproduce

From this repository with Node.js 22 or newer:

```bash
node scripts/validate-evidence-handoff.mjs
npm test
npm run check:privacy
```

The replay starts a real local HTTP service, uses an isolated temporary state directory, stops and restarts the process, and prints the checked outcomes as JSON. It makes zero external model calls and requires no API credentials.

| Check | Observed result |
| --- | --- |
| Automatic follow-ups before new evidence | Standard mode: 1. Evidence-first mode: 0. |
| Evidence-first session after process restart | The original objective, round count, wait decision, and next trigger persisted. |
| Delivery addressed to the wrong project | HTTP 409. Existing rounds and the pending queue were identical before and after the request. |
| Delivery addressed to the matching project | The original session opened T2 with the new evidence and recorded an advance decision. |

The four observations reproduced in five runs using fresh runtime directories on Node.js 22.23.4. These runs repeat the same fixture. The included regression suite covers additional behavior, including waiting and recovery, provider routing, and drafting and reviewing a bilingual manuscript against a synthetic number-trace fixture.

The comparison isolates the handling of a scripted wait signal in this case. Standard mode can also remain idle when automatic continuation is paused or the controller finishes its goal. The results do not estimate productivity, time savings, research quality, protection against arbitrary failures, or exactly-once delivery under retry and concurrency. Project checks prevent accidental mismatches when the caller supplies the expected project ID. They are application-level guards in a local workspace.

## 中文说明

这是一组受控的软件流程回放。两种模式使用同一版本、同一合成任务和同一本地脚本服务。在所需证据尚未到达时，脚本同时返回普通续航动作和证据阶段的等待裁决。普通模式按续航动作多开 1 轮，证据优先模式记录等待并自动开 0 轮。重启后原目标、回合数、等待裁决与下一触发条件保留。错误项目投递返回 409，回合和待件保持原样；正确项目补件后在原会话进入 T2。

Node.js 22.23.4 上用全新运行目录重复同一场景 5 次，观察结果一致。脚本只访问本机服务，外部模型调用为 0。结果只支持该场景下的流程行为。科研提效、研究结论质量、任意故障恢复以及重试和并发下的恰好一次投递，需要独立验证。
