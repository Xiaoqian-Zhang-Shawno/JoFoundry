/**
 * CCF-A 作战室 playbook：把"各参与模型互相讨论"变成一条能产出可投稿计划的链路。
 *
 * 阶段：
 *   brief    主持人把主题压成"可投稿的问题陈述"
 *   position 三方依次发言（后发言者能看到前面的人），各自给出最大胆但站得住的贡献主张
 *   rebuttal 倒序反驳：必须指名反对、必须让步一点、必须提出能定胜负的实验
 *   review   三方分别扮演三种审稿人原型，写模拟审稿意见与打分
 *   plan     主持人综合：故事线 / 实验矩阵 / 倒排时间线 / rebuttal 预案 / 红线
 *
 * 设计取向：这里做的是"录用工程"（acceptance engineering）——把贡献切到可验证、
 * 把审稿人已知的攻击提前补上、把故事压到一句话。红线写死在提示词里：不编数据、
 * 不隐瞒负面结果、不做不公平 baseline、不堆砌无 ablations。
 */

export const VENUES = {
  neurips: { name: 'NeurIPS', field: '机器学习', taste: '新洞察 > 大算力刷点；审稿人最烦"incremental"，最爱"原来如此"的机制解释与干净的对照实验' },
  icml: { name: 'ICML', field: '机器学习', taste: '理论保证或清晰的方法原理；实验要证伪关键假设，而不是只堆 SOTA' },
  iclr: { name: 'ICLR', field: '机器学习', taste: '开放评审，反驳价值高；重视可复现与"为什么有效"' },
  cvpr: { name: 'CVPR', field: '计算机视觉', taste: '任务级 SOTA + 泛化 + 充分 ablation + 可视化证据' },
  iccv: { name: 'ICCV', field: '计算机视觉', taste: '同类，更看重方法的新结构而非纯调参' },
  acl: { name: 'ACL', field: '自然语言处理', taste: '语言学洞察 + 数据泄漏审查 + 人工评测一致性' },
  emnlp: { name: 'EMNLP', field: '自然语言处理', taste: '实证充分性、错误分析质量' },
  aaai: { name: 'AAAI', field: '人工智能', taste: '广泛性与完整性；方法要能跨任务落地' },
  ijcai: { name: 'IJCAI', field: '人工智能', taste: '问题建模的清晰度与理论完整性' },
  kdd: { name: 'KDD', field: '数据挖掘', taste: '真实数据规模 + 线上/离线一致性 + 可部署性' },
  sigir: { name: 'SIGIR', field: '信息检索', taste: '评测协议严谨、baseline 强、显著性检验' },
  osdi: { name: 'OSDI', field: '系统', taste: '真实负载、端到端收益、实现陷阱与可复现工件' },
  sosp: { name: 'SOSP', field: '系统', taste: '同上，更看重设计取舍的深度' },
  nsdi: { name: 'NSDI', field: '网络系统', taste: '部署可行性与真实网络测量' },
  ccs: { name: 'CCS', field: '安全', taste: '威胁模型清晰、攻击/防御有效性、伦理审查' },
  usenixsec: { name: 'USENIX Security', field: '安全', taste: '真实系统影响 + 负责任披露' },
  icse: { name: 'ICSE', field: '软件工程', taste: '工程有效性 + 开发者研究 + 复现包' },
  generic: { name: 'CCF-A 会议', field: '通用', taste: '新颖性、重要性、技术严谨性、实验充分性、写作清晰度' },
}

const HARD_LINES = `铁律（违反即作废）：
- 不虚构数据、结果、引用或 baseline 数字；没有就写"待测"。
- 不隐瞒与主张相悖的已有结果；相反结果要写进"风险"。
- 不做不公平对照（同预算/同数据/同评测协议）。`

const JSON_ONLY = `\n输出：只输出一个 JSON 对象，无 markdown 围栏、无解释文字。字段名英文，内容中文（术语保留英文）。
**紧凑**：每个字符串字段 ≤ 80 字，数组 ≤ 5 项；宁可具体短句，不要长段落。整份 JSON 必须完整收尾，不能中途截断。`

/* ───────────────────────── 各阶段提示词 ───────────────────────── */

export function briefPrompt({ input, venue }) {
  const v = venue
  const system = `你是 CCF-A 论文的资深 Area Chair，擅长把模糊的研究兴趣压成"能过审的问题陈述"。
你判断一份选题的标准是：一句话能不能说清贡献，以及审稿人第一轮会不会问"so what"。${HARD_LINES}${JSON_ONLY}`
  const user = `【主题】${input.topic}
【领域】${input.field || v.field}
【目标会议】${v.name}（口味：${v.taste}）
${input.deadline ? `【截止】${input.deadline}` : ''}
${input.constraints ? `【资源】${input.constraints}` : ''}
${input.anchors ? `【已有材料】\n${String(input.anchors).slice(0, 5000)}` : ''}
${input.goal ? `【个人目标】${input.goal}` : ''}

输出：
{
  "one_sentence_claim": "如果论文中了，摘要第一句会怎么写（一句话，含对象与方法，不含'我们提出一个框架'这类空话）",
  "problem": "被解决的具体问题",
  "why_now": "为什么现在做（新能力/新数据/新需求）",
  "contribution_angles": ["3 个互不相同的贡献切法，每个注明类型：新问题/新方法/新发现/新系统"],
  "closest_work": ["3 个最近的工作方向（不确定标【需核验】）"],
  "reviewer_first_question": "审稿人看到标题后第一个会问的问题",
  "minimum_publishable_unit": "最小可发表单元：只做哪一件事就够投了"
}`
  return { system, user }
}

export function positionPrompt({ input, venue, brief, others, selfLabel }) {
  const v = venue
  const system = `你是 ${selfLabel}，正在参加一场 CCF-A 选题圆桌。目标不是和气，而是把这个选题推到"能中"。
你必须给出**最大胆但站得住**的贡献主张，并明确它的软肋。${HARD_LINES}${JSON_ONLY}`
  const user = `【会议】${v.name}（${v.taste}）
【主题】${input.topic}
【主持人的问题陈述】${JSON.stringify(brief, null, 2)}
${others.length ? `【前面发言的人说了什么】\n${others.map((o) => `- ${o.label}：${o.text}`).join('\n')}` : '【你是第一个发言】'}
${input.constraints ? `【资源约束】${input.constraints}` : ''}

你现在发言。要求：
- 必须与前面发言者有实质区别（如果你同意他们，就说出你比他们更进一步的地方）。
- 贡献主张要能被一句话复述，且能指出"哪张图/哪张表证明了它"。
- 明确说出这个主张最可能被审稿人打死的地方。

输出：
{
  "take": "你的立场（150 字以内）",
  "contribution_claim": "一句话贡献主张",
  "claim_type": "新问题 / 新方法 / 新发现 / 新系统",
  "key_figure_or_table": "支撑这个主张的核心图或表长什么样",
  "decisive_experiment": "一个能一锤定音的实验（含对照）",
  "biggest_risk": "最可能被审稿人打死的点",
  "disagreement": "你与前人发言的分歧（若你是第一个，写你要挑战的主流看法）",
  "what_would_change_my_mind": "什么结果会让你放弃这个主张"
}`
  return { system, user }
}

export function rebuttalPrompt({ input, venue, brief, transcript, selfLabel, order }) {
  const v = venue
  const system = `你是 ${selfLabel}，圆桌第二轮。规则：必须点名反驳至少一条别人的主张，必须主动让步一点，
必须提出一个能判定胜负的实验，然后修正自己的主张。禁止和稀泥。${HARD_LINES}${JSON_ONLY}`
  const user = `【会议】${v.name}
【主题】${input.topic}
【问题陈述】${JSON.stringify(brief, null, 2)}
【第一轮全部发言】
${transcript.map((t) => `- ${t.label}：${t.text}`).join('\n')}

${order === 'last' ? '【你是本轮的总结发言者】除了反驳，还要指出三分歧中哪个是真正关键的分歧，并给出裁决方案。' : ''}

输出：
{
  "disagree_with": "你点名反驳谁、反驳哪一句",
  "why_wrong": "为什么那句站不住（机制/实验/逻辑层面的具体理由）",
  "concede": "你接受别人哪一点，为什么",
  "decisive_test": "一个能裁决你俩分歧的实验（数据、对照、读出、判定阈值）",
  "revised_claim": "修正后的你的主张（一句话）",
  "new_risk": "修正后新出现的风险",
  "if_i_am_wrong": "如果错的是你，论文会发生什么（这决定选题的容错度）"
}`
  return { system, user }
}

export const REVIEWER_PERSONAS = {
  novelty: {
    name: '审稿人 A（新颖性警察）',
    voice: '你见过太多"A+B"式论文。你要问：相对于最近的三篇工作，这篇的真正新意是什么？如果拿掉它的核心组件，结论还成立吗？',
    focus: ['与最接近工作的差异是否真实', '是否存在"换数据集/换 backbone"式增量', '贡献是否可被一句话概括'],
  },
  rigor: {
    name: '审稿人 B（实验严厉派）',
    voice: '你只认证据。你要问：baseline 是否公平（同预算/同数据/同评测）？ablation 是否覆盖了每一个被声称的机制？显著性检验做了吗？',
    focus: ['baseline 公平性与强度', 'ablation 是否支撑机制主张', '方差/显著性/多次运行', '是否只在单一数据集上成立'],
  },
  impact: {
    name: '审稿人 C（故事与影响）',
    voice: '你关心"so what"。你要问：如果这篇成立，谁会改变做法？它的失效边界在哪？写作上能不能三句话说清？',
    focus: ['影响力与受众', '失效边界与适用条件', '写作清晰度与图表信息密度'],
  },
}

export function reviewPrompt({ input, venue, brief, transcript, persona }) {
  const v = venue
  const system = `你是 ${persona.name}。${persona.voice}
你写的是**模拟审稿意见**，目的是让作者在投稿前把洞补上。你的打分要保守（CCF-A 的真实分布偏严）。
关注点：${persona.focus.join('；')}。${HARD_LINES}${JSON_ONLY}`
  const user = `【会议】${v.name}（${v.taste}）
【主题】${input.topic}
【问题陈述】${JSON.stringify(brief, null, 2)}
【圆桌讨论记录】
${transcript.map((t) => `- ${t.label}：${t.text}`).join('\n')}

请以你的审稿人格给出评审：
{
  "persona": "${persona.name}",
  "summary": "用两句话复述你以为这篇论文在做什么（若你复述错了，说明作者的表述有问题）",
  "scores": { "novelty": 1-10, "rigor": 1-10, "impact": 1-10, "clarity": 1-10, "overall": 1-10 },
  "verdict": "strong accept / accept / borderline / reject / strong reject",
  "strengths": ["2-3 条"],
  "weaknesses": ["3-5 条，要具体到'缺哪个实验/哪句论证不成立'"],
  "fatal_if_unaddressed": ["若不补就会直接拒的 1-3 条"],
  "required_experiments": ["补齐就能升分的实验清单"],
  "questions_to_authors": ["你会在 rebuttal 阶段追问的问题"],
  "what_would_raise_my_score": "作者做什么最能让你的分数上去"
}`
  return { system, user }
}

export function planPrompt({ input, venue, brief, transcript, reviews }) {
  const v = venue
  const system = `你是这篇论文的资深合作者（相当于有 20 篇 CCF-A 经验的 PI）。你要把圆桌讨论与模拟审稿
收敛成一份**明天就能开工**的投稿作战计划。你不回避风险，也不夸大结果。${HARD_LINES}${JSON_ONLY}`
  const user = `【会议】${v.name}（口味：${v.taste}）
【主题】${input.topic}
${input.deadline ? `【截止】${input.deadline}` : ''}
${input.constraints ? `【资源】${input.constraints}` : ''}
【问题陈述】${JSON.stringify(brief, null, 2)}
【圆桌记录】
${transcript.map((t) => `- ${t.label}：${t.text}`).join('\n')}
【模拟审稿】
${JSON.stringify(reviews, null, 2)}

输出（务必紧凑：每个字符串 ≤ 70 字；timeline ≤ 5 行；rebuttal_ammo ≤ 4 条；figures ≤ 6 条；务必完整收尾）：
{
  "title_candidates": ["3 个候选标题（具体、可检索、不夸张）"],
  "one_sentence_claim": "摘要第一句",
  "story": {
    "hook": "引言第一段的钩子（现实问题或反直觉现象）",
    "gap": "已有工作缺什么（1 句）",
    "insight": "你的关键洞察（1 句）",
    "evidence": "证据链：第 2/3 节各证明什么"
  },
  "contributions": ["3 条贡献，每条必须对应一张图或表"],
  "experiment_matrix": {
    "main_table": { "rows": ["方法/变体"], "cols": ["数据集/指标"], "must_include": ["必做的 baseline"] },
    "ablations": ["必须做的消融，每条对应一个被声称的机制"],
    "datasets": ["数据集与来源，标注是否需申请"],
    "metrics": ["指标 + 显著性检验方式"],
    "robustness": ["跨域/跨规模/超参敏感性"]
  },
  "figures": [ { "id": "Fig.1", "purpose": "证明什么", "type": "示意图/曲线/表格" } ],
  "timeline": [ { "phase": "第 1-2 周", "deliverable": "具体产物", "go_no_go": "什么情况继续/止损" } ],
  "rebuttal_ammo": [ { "likely_attack": "审稿人可能说", "preemptive_fix": "现在就补上的动作", "rebuttal_line": "到时候怎么答" } ],
  "kill_criteria": ["出现什么结果就换题"],
  "red_lines": ["本项目绝对不能做的事（数据/伦理/引用）"],
  "next_three_actions": ["接下来 72 小时做哪三件事"]
}`
  return { system, user }
}

/**
 * 计划拆两段（单次输出容易撞 max_tokens 被截断）：
 *   core = 标题/主张/故事/贡献；ops = 实验矩阵/图表/时间线/rebuttal/止损/红线/72小时
 */
export function planPromptPart({ input, venue, brief, transcript, reviews }, part) {
  const v = venue
  const common = `【会议】${v.name}（口味：${v.taste}）
【主题】${input.topic}
${input.deadline ? `【截止】${input.deadline}` : ''}
${input.constraints ? `【资源】${input.constraints}` : ''}
【问题陈述】${JSON.stringify(brief, null, 2)}
【圆桌记录】
${transcript.map((t) => `- ${t.label}：${t.text}`).join('\n')}
${reviews?.length ? `【模拟审稿】${JSON.stringify(reviews, null, 2)}` : ''}`

  if (part === 'core') {
    return {
      system: `你是这篇论文的资深合作者（PI 级）。只负责把讨论收敛成"故事与贡献"这一半，
不写实验细节。${HARD_LINES}${JSON_ONLY}`,
      user: `${common}

输出（紧凑：每字段 ≤ 70 字；务必完整收尾）：
{
  "title_candidates": ["3 个候选标题"],
  "one_sentence_claim": "摘要第一句",
  "story": { "hook": "钩子", "gap": "缺口", "insight": "洞察", "evidence": "证据链：各节证明什么" },
  "contributions": ["3 条贡献，每条对应一张图表"]
}`,
    }
  }

  return {
    system: `你是这篇论文的资深合作者（PI 级）。只负责"执行层"：实验矩阵、图表、时间线、rebuttal 预案、止损与红线。
不重写故事，不重复贡献。${HARD_LINES}${JSON_ONLY}`,
    user: `${common}

输出（紧凑：每字段 ≤ 70 字；数组 ≤ 6 项；务必完整收尾）：
{
  "experiment_matrix": {
    "main_table": { "rows": ["方法/变体"], "cols": ["数据集/指标"], "must_include": ["必做 baseline"] },
    "ablations": ["每个被声称的机制一个消融"],
    "datasets": ["数据集与来源"],
    "metrics": ["指标 + 显著性检验"],
    "robustness": ["跨域/跨规模/敏感性"]
  },
  "figures": [ { "id": "Fig.1", "purpose": "证明什么", "type": "示意/曲线/表格" } ],
  "timeline": [ { "phase": "第 1-2 周", "deliverable": "产物", "go_no_go": "继续/止损判据" } ],
  "rebuttal_ammo": [ { "likely_attack": "可能的攻击", "preemptive_fix": "现在补什么", "rebuttal_line": "怎么答" } ],
  "kill_criteria": ["出现什么就换题"],
  "red_lines": ["绝对不能做的事"],
  "next_three_actions": ["72 小时内三件事"]
}`,
  }
}

export function reviewAggregatePrompt({ input, venue, brief, reviews }) {
  const v = venue
  const system = `你是 Area Chair。把三份互相冲突的审稿意见合成一份决策建议，指出真正的分歧点与最小决胜实验。${HARD_LINES}${JSON_ONLY}`
  const user = `【会议】${v.name}
【主题】${input.topic}
【问题陈述】${JSON.stringify(brief, null, 2)}
【审稿意见】${JSON.stringify(reviews, null, 2)}

输出：
{
  "scores_table": [ { "persona": "...", "overall": 1-10, "verdict": "..." } ],
  "consensus_weaknesses": ["多位审稿人都指出的问题（这些是必须补的）"],
  "contested_points": ["审稿人之间互相矛盾的地方"],
  "ac_decision": "按当前状态最可能的决定",
  "minimum_path_to_accept": ["按优先级排序的补齐动作"],
  "decisive_experiment": "一个实验，做了能把最弱的那个分数拉起来"
}`
  return { system, user }
}

/** 补全缺失字段：模型偶尔会"自行省略"若干键，这里点名要回来。 */
export function planRepairPrompt({ input, venue, brief }, part, missing) {
  const v = venue
  return {
    system: `你是论文合作者。上一版计划 JSON 缺少字段，现在只补齐缺失字段，不要重复已有内容。${HARD_LINES}${JSON_ONLY}`,
    user: `【会议】${v.name}
【主题】${input.topic}
【问题陈述】${JSON.stringify(brief, null, 2)}

上一版缺少这些字段：${missing.join(', ')}

只输出一个 JSON 对象，且**只包含**这些键（内容与 ${part} 部分一致，紧凑：每字段 ≤ 70 字）：
${missing.map((k) => `  "${k}": ...`).join('\n')}`,
  }
}
