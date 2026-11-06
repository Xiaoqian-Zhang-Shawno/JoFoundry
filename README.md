# Research Foundry · 总控协作

本地运行的多模型科研协作工具。总控、执行者和评审者均可自由配置，不绑定特定厂商、模型名称或三个参与者；同一个模型也可以承担不同角色。

总控协作页面：`http://127.0.0.1:8787/.research-foundry/command`。

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 能做什么

- 总控把目标拆成任务，执行者交付后逐份裁决、修订或接续。
- 会话公告板、阶段反馈和长期记忆帮助多轮工作保持连贯。
- 回合折叠、历史分组、显示过程、只看最新与自动跟随控制长会话阅读。
- 分歧讨论保留证据核验状态；模型评审结果按贡献版本缓存。
- 侧栏支持新建、折叠项目，并将已有会话移入项目。会话的材料与记忆各自管理。
- 目标续航可在空闲会话直接启动，按目标的完成条件继续推进，显示重试与阻塞状态。会话、目标和调用记录保存在本地。
- CCF-A 进度图按评估时间展示进度与回合理由。
- 另有科研圆桌、命令行和可选 DSH 插件入口。

这是一套讨论与任务协调工具。文本模型不能直接访问本机或服务器；Codex 适配器在临时目录以 read-only 沙箱运行。实际训练、GPU 调度及跨聊天执行桥需要用户另行接入。模型互审和评分是辅助信号，不能证明创新性或保证录用。裁决失败时现有流程可能降级继续，重要结论应检查原始调用和证据。

## 开始使用

需要 Node.js 22+。独立服务仅使用 Node 内置模块，无需安装运行依赖。Codex 线路需要另行安装并登录兼容的 Codex CLI；CLI 参数兼容性取决于本机版本。DSH 插件才需要 package.json 中的可选 peer dependencies。

先用 mock 模式体验，不调用模型服务：

```bash
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm start
```

打开总控协作页面，创建一个示例会话并发送问题。mock 输出只验证流程，不代表真实模型能力。

真实调用可以先用默认的「总控 + 一个执行者」配置。在 shell 中分别指定两条线路的兼容端点、模型 ID 和密钥：

```bash
export FOUNDRY_CONTROLLER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_CONTROLLER_MODEL='YOUR_MODEL_ID'
export FOUNDRY_WORKER_BASE_URL='http://localhost:1234/v1'
export FOUNDRY_WORKER_MODEL='YOUR_MODEL_ID'
# 需要认证的服务再设置 FOUNDRY_CONTROLLER_API_KEY / FOUNDRY_WORKER_API_KEY
npm start
```

`.env.example` 是字段说明，程序不会自动加载它。不要把真实密钥写进仓库。API、订阅和探针调用可能产生费用或消耗额度；自动续航和多轮评审会增加调用量，首次使用请保持自动续航关闭。

默认配置与数据位于 `~/.dsh/research-foundry/`。可用 `FOUNDRY_HOME` 指定一个新的私有目录。默认不预设服务商端点或模型 ID。环境变量中的密钥仅在运行时使用，不自动写回配置。

## 自定义模型、数量和角色

将 [示例配置](examples/config.example.json) 复制到运行目录的 `config.json`，修改后重启服务。`lanes` 是完整参与者名单，替换默认示例，不会隐式添加额外模型。每条线路的 ID 可自定义；总控协作需要至少一个总控和一个执行者，圆桌模式可使用单条或多条线路。

```json
{
  "lanes": {
    "planner": { "kind": "openai", "label": "规划模型", "baseUrl": "http://localhost:1234/v1", "model": "YOUR_MODEL_ID", "apiKeyEnv": "PLANNER_API_KEY" },
    "solver": { "kind": "openai", "label": "实现模型", "baseUrl": "http://localhost:1234/v1", "model": "YOUR_MODEL_ID", "apiKeyEnv": "SOLVER_API_KEY" }
  },
  "protocol": { "controller": "planner", "workers": ["solver"], "reviewers": ["planner", "solver"], "reviewRounds": 2, "reviewPassRatio": 0.8 }
}
```

可按需要增加执行者，也可为不同角色使用同一端点和模型。网页会按配置生成参与者、执行者选项、评审网格和用量面板。

| `kind` | 接口 | 配置要点 |
|---|---|---|
| `openai` | Chat Completions 兼容接口 | `baseUrl` 填接口前缀（例如以 `/v1` 结尾），程序追加 `/chat/completions`；支持无需密钥的本地服务 |
| `anthropic` | Anthropic Messages 兼容接口 | `baseUrl` 填服务根地址，程序追加 `/v1/messages`；配置 `apiKeyEnv` |
| `codex` | 本机 Codex CLI | 配置 `bin`、可选 `model` 和 `reasoning`；需本机登录及兼容的 CLI 版本 |
| `deepseek` | 旧版专用适配器 | 保留旧配置兼容；新配置也可选择通用 `openai` 兼容方式 |

每条线路可设置 `apiKeyEnv`、`modelEnv`、`baseUrlEnv`、`binEnv`，引用自己选择的环境变量；`strengths` 可描述执行者的任务专长。支持范围由接口协议决定：只提供其他专有协议或 Responses 接口的服务需要新增适配器，不能仅改模型名。

`protocol.controller` 选择总控（旧字段 `lead` 仍兼容）；未指定时优先选 `role: "controller"`，否则选第一条启用线路。执行者默认是其他所有启用线路；评审者默认是所有启用线路。每位评审者的轮数与通过比例可调整，门槛为 `ceil(评审人数 × 轮数 × 比例)`。失败或不完整的评审不会算通过。评审缓存同时绑定贡献内容、评审模型/端点、轮数、门槛与规则，换配置后不会误用旧结果。

旧配置中明确列出的 `deepseek` / `claude` / `chatgpt` ID 及原环境变量保持兼容。已有会话保留原线路 ID；更换名单后请新建会话或保留旧 ID，避免恢复旧任务时找不到参与者。

```bash
node lib/cli.mjs init             # 写入默认配置；已有配置时请勿运行
node lib/cli.mjs probe            # 发起真实模型探针
node lib/cli.mjs run --topic "示例研究问题" --mode paper
node lib/cli.mjs list
```

## 成稿、人工审稿与供应商切换

总控页的「人机审稿」可按当前会话生成分节的中英初稿，标出未在会话材料中找到的数字，并对指定段落添加审稿意见。数字匹配只能提示回查，仍需核对数字的来源和含义。补实验的建议可排入下一回合，生成实验方案供用户核验。

可为一条线路设置 `providers` 数组。每项填写唯一的 `id`、`kind`（`openai` 或 `anthropic`）、`baseUrl`、`model`，需要认证时填写 `apiKeyEnv`（环境变量名称）。配置中的 `active` 指定默认首选。总控页的切换在当前进程生效，重启后回到配置文件中的首选。遇到可重试的错误时，提示词可发给该线路的其他启用供应商，请只配置允许处理同一批材料的服务。

### API 额度

在需要查询额度的线路或供应商上设置 `"balance": true`，并照常用 `apiKeyEnv` 配置密钥。当前支持 [灵眸](https://docs.lmuai.ai/cn/docs/api/balance) 的密钥可用额度，以及 [OpenRouter](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key) 的密钥用量和独立限额。供应商列表会按当前首选查询，结果只在本地用量面板及其 API 展示。OpenRouter 的账户余额可在其控制台查看。

## 材料、技能和记忆

公开版默认不读取个人 AGENTS.md、Codex 会话日志、其他应用登录态或任何已有 Obsidian 项目。知识源通过 `config.json` 的 `knowledge.extraSources` 显式指定；技能目录通过 `FOUNDRY_SKILLS_DIR` 显式指定，默认是运行目录下的空 skills 目录。`knowledge.deepSkills` 可列出允许精读的技能名称。

会话中填写的材料、显式配置的知识源与技能内容会进入模型提示词，并发送到相应服务商。请只添加允许发送的材料。长期记忆默认保存在运行目录的 `memory/`；可用 `memory.obsidianDir` 显式指定导出目录。

服务没有用户认证，只适合可信本机使用，保留默认的 `127.0.0.1` 监听。不要映射到公网或共享网络。状态端口为主端口加一，包含会话信息；`/ask` 会调用模型。运行目录包含私密材料和模型输出，应保持在 Git 仓库外，并自行备份。

## 验证

```bash
npm test
npm run check:privacy
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm run mock
```

自动测试覆盖凭据不落盘、默认知识源隔离、无账户自动发现、2/3/4 个自定义参与者的总控 mock 流程、分歧终裁、动态评审与缓存隔离、通用接口请求和会话恢复。隐私扫描只报告文件名与规则，不打印疑似凭据；它是启发式检查，仍需人工复核将要发布的文件。

## 结构

- `lib/engine/command.mjs`：总控派工、互审、裁决、记忆和续航。
- `lib/engine/lanes.mjs`：HTTP 与 Codex CLI 适配器。
- `lib/engine/knowledge.mjs`：显式知识源、技能及摘要。
- `lib/runtime.mjs` / `lib/server.mjs`：本地 HTTP 服务。
- `lib/gui/`：网页界面；`lib/cli.mjs`：命令行入口。

本仓库是源码专用公开版本，不含运行数据、私人研究材料、截图、账户配置或原环境历史。见 [发布检查记录](docs/PUBLIC_RELEASE.md)。

## License

MIT。可选平台、CLI、模型服务和用户另行提供的技能或材料遵循各自许可及服务条款。
