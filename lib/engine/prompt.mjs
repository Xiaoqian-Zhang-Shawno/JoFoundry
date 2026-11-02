/**
 * 提示词层：整个「灵感工坊」的质量主要在这里。
 *
 * 设计原则：
 *  1. 先立简报（brief），避免三条线对着一句含糊的话各自复读。
 *  2. 发散阶段给每条线**不同的认知透镜**，而不是同一个问题问三遍——
 *     异构性来自"看问题的角度"，不是来自"换个模型"。
 *  3. 盲评阶段隐去作者身份、打乱顺序，压制"对自己的想法手下留情"。
 *  4. 综合阶段强制回应最强反对意见，并给出 kill switch（可杀死假设的判据）。
 *  5. 研究诚信写进每一条提示词：不确定的文献标 "需核验"，不许编造引文。
 */

const LENSES = {
  mechanism: {
    name: '机制缺口',
    brief: `从因果机制切入。找出该领域"已知 A→B"链条中真正断裂或缺失的一环，
提出可检验的机制假设。禁止把"换个数据集 / 换个 backbone / 加个模块"当作想法。
一个好想法的标志：它能解释一个现有理论解释不了的已发表现象。`,
  },
  measurement: {
    name: '测量与范式',
    brief: `从测量、指标与实验范式的局限倒推。问：现有指标测不到什么现象？哪些相互竞争的假设
在现有设计下根本无法区分？然后设计一个新的可观测代理量、扰动方式或实验范式，
让原本不可区分的假设变得可区分。想法的价值在于"让某个长期争论变成可判定的"。`,
  },
  analogy: {
    name: '跨域移植',
    brief: `从邻近学科横向移植。找一个在别的领域已经被验证过的机制、工具或测量方法，
判断它能否解决本领域的一个硬问题。必须说清三件事：结构同构在哪里（为什么这次迁移是合法的）、
迁移会失效的边界条件、以及移植后能做出什么本领域原本做不出的预测。`,
  },
}

const JSON_ONLY = `\n\n输出要求：只输出一个 JSON 对象。不要 markdown 代码围栏，不要前后解释文字，不要注释。字段名用英文，内容用中文（专有名词保留英文）。`

const INTEGRITY = `\n研究诚信：不要编造论文标题、作者或年份。若必须引用具体工作，用"方法名/方向名 + 大致年份"描述，并在 \`verify\` 字段标 true 表示需要人工核验。宁可写"该方向已有工作，需核验"，也不要虚构一篇不存在的论文。`

const IDEA_SCHEMA = `{
  "ideas": [
    {
      "title": "一句话标题（≤20字，具体，不要"探索…的研究"这种空壳）",
      "one_liner": "一句话说清做什么、为什么重要",
      "gap": "现有知识/方法的具体缺口（要能指向某类现象或某类失败）",
      "hypothesis": "可检验的假设，形式：若…则…",
      "mechanism": "为什么这个假设在机制上成立（因果链，不是相关性）",
      "predictions": ["2-3 条可观测、可被证伪的预测"],
      "minimal_experiment": {
        "data": "需要什么数据/样本/体系，是否可以现成获得",
        "method": "最小可行实验设计（关键对照组、扰动、读出）",
        "effort": "人月量级估计",
        "cost": "经费/算力量级（低/中/高 + 粗估）"
      },
      "novelty_vs_literature": "与最接近的已有工作的差别；不确定的标【需核验】",
      "why_now": "为什么现在做才成立（新数据/新工具/新理论）",
      "risks": ["2-3 条最可能让这个想法失败的原因"],
      "kill_criterion": "什么结果出现就应当放弃这个想法"
    }
  ]
}`

export function briefPrompt(cfg, input) {
  const { topic, field, constraints, anchors, goal } = input
  const system = `你是资深研究策略顾问，擅长把一个模糊的研究兴趣，压成一份可执行的研究简报。
你的判断标准是"能不能据此设计实验"，不是"听起来有没有道理"。${INTEGRITY}${JSON_ONLY}`
  const user = `【研究方向】${topic}
${field ? `【领域】${field}` : ''}
${goal ? `【想达成的目标】${goal}` : ''}
${constraints ? `【资源与约束】${constraints}` : '【资源与约束】未说明，按"一个研究生 + 普通算力 + 3-6 个月"估计'}
${anchors ? `【已有线索/文献/数据】\n${String(anchors).slice(0, 6000)}` : ''}

请输出这份简报的 JSON：
{
  "problem": "把方向收敛成一个具体的科学问题（一句话，含对象与关系）",
  "why_hard": "为什么它还没被解决（技术/数据/概念哪一层卡住）",
  "known": ["3-5 条该领域较确定的共识（不确定的标【需核验】）"],
  "unknowns": ["3-5 个真正的未知，按重要性排序"],
  "competing_framings": ["2-3 种互不兼容的解释框架或技术路线"],
  "success_criteria": "什么样的结果才算这个方向有实质推进",
  "traps": ["2-3 个最容易掉进去的坑（伪问题、不可识别、已被做过）"]
}`
  return { system, user }
}

export function divergePrompt(cfg, brief, lane, lensKey, seedsPerLane) {
  const lens = LENSES[lensKey] || LENSES.mechanism
  const system = `你是顶尖科研选题专家。你这一轮被分配到的认知透镜是【${lens.name}】：
${lens.brief}

你必须严格用这个透镜思考，不要写成通用综述。宁可尖锐、可争议，也不要四平八稳。${INTEGRITY}${JSON_ONLY}`
  const user = `【研究简报】
${JSON.stringify(brief, null, 2)}

请用【${lens.name}】透镜，产出 ${seedsPerLane} 个**互不相同**的想法，其中至少 1 个是"高风险高回报"的
（若成功会改变领域做法，但失败概率 > 50%）。三个想法不要是同一个想法的三个变体。

${IDEA_SCHEMA}`
  return { system, user }
}

export function critiquePrompt(cfg, brief, seeds) {
  const system = `你是最苛刻的审稿人（顶刊/顶会 level）。你的任务是找出致命缺陷，不是夸奖。
对每个想法依次判断：
- novelty：与已知工作的差异是真实的，还是"换个说法"？
- significance：若成立，领域里谁会因此改变做法？
- feasibility：用简报中的资源，3-6 个月内能否做出关键实验？
- testability：预测是否可被证伪，还是永远对（不可证伪 = 1 分）？
你没把握的具体文献，写进 closest_prior_work 并标【需核验】，不要编造。${INTEGRITY}${JSON_ONLY}`
  const user = `【研究简报】
${JSON.stringify(brief, null, 2)}

【待评审的想法（已隐去来源，编号见 id）】
${JSON.stringify(seeds, null, 2)}

输出：
{
  "reviews": [
    {
      "id": "对应想法 id",
      "novelty": 1-5,
      "significance": 1-5,
      "feasibility": 1-5,
      "testability": 1-5,
      "fatal_flaws": ["最致命的 1-3 条"],
      "strongest_objection": "如果只能提一条反对意见，是哪条（要具体，不要套话）",
      "closest_prior_work": "最接近的已有工作或方向（不确定标【需核验】）",
      "repair": "在不放弃核心洞察的前提下，怎么修（一句具体修改）"
    }
  ]
}`
  return { system, user }
}

export function synthesisPrompt(cfg, brief, seeds, critiques, scores) {
  const system = `你是研究组的 PI，要在有限资源下决定做什么。你不追求"看起来全面"，
而是挑出值得下注的 3 条，并把它们写成能让组里明天就开工的方案。
必须正面回应审稿人的最强反对意见：要么修补，要么承认并降低主张，不许绕过去。${INTEGRITY}${JSON_ONLY}`
  const user = `【研究简报】
${JSON.stringify(brief, null, 2)}

【候选想法】
${JSON.stringify(seeds, null, 2)}

【盲评结果】
${JSON.stringify(critiques, null, 2)}

【加权评分（novelty 0.35 / significance 0.30 / feasibility 0.20 / testability 0.15）】
${JSON.stringify(scores, null, 2)}

要求：
1. 合并同质想法（把它们合成一条更强的），不要凑数。
2. 最终保留 3 条，按"建议下注顺序"排序。
3. 每条必须写明它如何回应最强反对意见。
4. 每条给出 **2 周内可完成的 pilot**（这是判断它是真是假的关键动作）。
5. 给出 kill switch：出现什么结果就该停。

输出：
{
  "portfolio_rationale": "为什么是这 3 条组合（互补性/风险分散）",
  "proposals": [
    {
      "rank": 1,
      "title": "标题",
      "pitch": "两句话：做什么、可能改变什么",
      "chain": { "gap": "...", "hypothesis": "...", "prediction": "..." },
      "why_it_works": "机制上为什么可能成立",
      "pilot": { "steps": ["2 周内的 3-5 个具体动作"], "data": "...", "compute": "...", "time": "..." },
      "expected_result": "预期看到什么",
      "interpretation": "看到 X 说明什么，看到 Y 说明什么",
      "falsification": "什么结果会证伪它",
      "resources": "所需数据/设备/合作者",
      "risks": ["主要风险"],
      "prior_work_to_verify": ["需要人工核验的最接近工作（3 条以内）"],
      "reviewer_objections": ["预判审稿人会问什么，以及你怎么答"],
      "next_steps": ["pilot 通过后的 3 步"]
    }
  ],
  "pick": "如果只能做一条，做哪条，为什么",
  "kill_switches": ["全局止损条件"],
  "open_questions_for_human": ["需要你（研究者）自己判断、模型无法替你决定的问题"]
}`
  return { system, user }
}

export const LENS_MAP = LENSES
