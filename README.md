# Research Foundry · 总控协作

本地运行的多模型科研协作工具：Claude 担任总控，DeepSeek 和 Codex 担任执行者，围绕用户的问题派工、互审、裁决并综合结果。

总控协作页面：`http://127.0.0.1:8787/.research-foundry/command`。

## 能做什么

- 总控把目标拆成任务，执行者交付后逐份裁决、修订或接续。
- 会话公告板、阶段反馈和长期记忆帮助多轮工作保持连贯。
- 分歧讨论保留证据核验状态；模型评审结果按贡献版本缓存。
- 可选自动续航；会话、调用记录和产物保存在本地运行目录。
- 另有科研圆桌、命令行和可选 DSH 插件入口。

这是一套讨论与任务协调工具。文本模型不能直接访问本机或服务器；Codex 适配器在临时目录以 read-only 沙箱运行。实际训练、GPU 调度及跨聊天执行桥需要用户另行接入。模型互审和评分是辅助信号，不能证明创新性或保证录用。裁决失败时现有流程可能降级继续，重要结论应检查原始调用和证据。

## 开始使用

需要 Node.js 22+。独立服务仅使用 Node 内置模块，无需安装运行依赖。Codex 线路需要另行安装并登录兼容的 Codex CLI；CLI 参数兼容性取决于本机版本。DSH 插件才需要 package.json 中的可选 peer dependencies。

先用 mock 模式体验，不调用模型服务：

```bash
FOUNDRY_MOCK=1 FOUNDRY_HOME="$(mktemp -d)" npm start
```

打开总控协作页面，创建一个示例会话并发送问题。mock 输出只验证流程，不代表真实模型能力。

真实调用前，在 shell 中显式配置凭据和你有权使用的模型 ID：

```bash
export DEEPSEEK_API_KEY='YOUR_DEEPSEEK_KEY'
export DEEPSEEK_MODEL='YOUR_DEEPSEEK_MODEL_ID'
export ANTHROPIC_API_KEY='YOUR_ANTHROPIC_KEY'
export ANTHROPIC_MODEL='YOUR_ANTHROPIC_MODEL_ID'
export CODEX_BIN=codex
npm start
```

`.env.example` 是字段说明，程序不会自动加载它。不要把真实密钥写进仓库。API、订阅和探针调用可能产生费用或消耗额度；自动续航和多轮评审会增加调用量，首次使用请保持自动续航关闭。

默认配置与数据位于 `~/.dsh/research-foundry/`。可用 `FOUNDRY_HOME` 指定一个新的私有目录。`config.json` 可覆盖 lanes 的 `baseUrl`、`model`、`bin` 等配置，环境变量中的密钥仅在运行时使用，不自动写回配置。默认 HTTP 端点为 DeepSeek 官方端点及 Anthropic 官方端点；模型 ID 不预设。

```bash
node lib/cli.mjs init             # 写入默认配置；已有配置时请勿运行
node lib/cli.mjs probe            # 发起真实模型探针
node lib/cli.mjs run --topic "示例研究问题" --mode paper
node lib/cli.mjs list
```

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

自动测试覆盖凭据不落盘、默认知识源隔离、无账户自动发现、总控 mock 流程和会话恢复。隐私扫描只报告文件名与规则，不打印疑似凭据；它是启发式检查，仍需人工复核将要发布的文件。

## 结构

- `lib/engine/command.mjs`：总控派工、互审、裁决、记忆和续航。
- `lib/engine/lanes.mjs`：HTTP 与 Codex CLI 适配器。
- `lib/engine/knowledge.mjs`：显式知识源、技能及摘要。
- `lib/runtime.mjs` / `lib/server.mjs`：本地 HTTP 服务。
- `lib/gui/`：网页界面；`lib/cli.mjs`：命令行入口。

本仓库是源码专用公开版本，不含运行数据、私人研究材料、截图、账户配置或原环境历史。见 [发布检查记录](docs/PUBLIC_RELEASE.md)。

## License

MIT。可选平台、CLI、模型服务和用户另行提供的技能或材料遵循各自许可及服务条款。
