/**
 * BadgeCore 沟通分析管道（06 册 AI-04~06/10，D8 违规判活；09 册场景模板 INT-10~13）
 * -------------------------------------------------------
 * 输入：转写文本（可含"说话人N:"轮次）+ 企业配置（成交模型/任务模型/竞品库/违规项）+ 场景 scene
 * 输出：结构化报告 JSON（按场景分型）：
 *   sales    摘要/关键信息/立场/竞品/意向度/任务达成/违规/待办（对外销售场景，03 册 ANA）
 *   meeting  会议纪要：分议题/决议/行动项/争议/未决（09 册 §4.1）
 *   training 培训·讲座沉淀：知识点/答疑/金句/考核题/章节（09 册 §4.2）
 *   talk     管理谈话：双向承诺/讨论问题/未决（09 册 §4.3；K5 红线：不做情绪/态度评分）
 *
 * LLM 供应商：OpenAI 兼容 /chat/completions（GLM/DeepSeek/Qwen 均兼容），配置在后台「设置」页；
 * provider=mock 时用本地确定性 Mock（测试管道用，不调网络）。
 * 所有报告带 meta.ai_generated=true（07 册 CMP-17 AI 生成标识）。
 * 输出层过 redact.js（07 册 CMP-07 敏感信息脱敏，双层防御的第二层）。
 */
const { redactDeep } = require('./redact');

const SCENES = ['sales', 'meeting', 'training', 'talk'];

// ---------- 报告骨架（按场景分型，09 册 §4） ----------
function reportSkeleton(scene = 'sales') {
  const base = { summary: '' };
  if (scene === 'meeting') {
    return { ...base,
      topics: [],          // [{topic, conclusion, discussion}]
      decisions: [],       // [{what, owner, evidence}]
      action_items: [],    // [{what, owner, due}]
      disputes: [],        // [{topic, side_a, side_b, status}]
      open_issues: [],     // string[]
      attendees_hint: 0,   // 发言人数估计
    };
  }
  if (scene === 'training') {
    return { ...base,
      knowledge_points: [], // [{point, detail, evidence}]
      qa: [],              // [{q, a}]
      quotes: [],          // string[]
      quiz: [],            // [{question, answer, evidence}]
      chapters: [],        // [{time_hint, title, gist}]
    };
  }
  if (scene === 'talk') {
    return { ...base,
      commitments: [],      // [{by, what, due, evidence}]
      issues_discussed: [], // string[]
      unresolved: [],       // string[]
      next_review: '',      // 建议回顾时点与内容
    };
  }
  return { ...base,
    key_facts: [],                    // ANA-01 [{k, v}]
    stance: { support: [], concerns: [], unmentioned: [] }, // ANA-03
    competitors: [],                  // ANA-04 [{name, mentions, our_advantage, risk}]
    intention: { score: 0, level: '低', reasons: [] },        // ANA-05
    tasks: [],                        // ANA-06 [{item, status: 完成|未提及|不充分, evidence}]
    violations: [],                   // ANA-08 [{item, evidence, severity}]
    todos: [],                        // ANA-10 [{what, due}]
  };
}

// ---------- Prompt（06 册 3.2：配置注入 + JSON Schema 约束 + 原文可溯源；09 册场景分型） ----------
const COMMON_RULES = `硬规则：
1. 每条结论的 evidence 必须引用转写原文片段，禁止编造。
2. 全文无相关信息时对应字段给空数组/空串，不要硬凑。`;

const SCENE_PROMPTS = {
  sales: {
    label: '销售沟通',
    sys: (cfg) => `你是企业销售沟通分析引擎。根据「转写文本」与「企业配置」输出严格 JSON，不要输出 JSON 以外的任何文字（包括 markdown 代码围栏）。
输出对象键及类型：
summary: string（3~5 句，结论先行）
key_facts: [{k: string, v: string}]（时间/地点/预算/下一步等关键信息）
stance: {support: string[], concerns: string[], unmentioned: string[]}
competitors: [{name: string, mentions: number, our_advantage: string, risk: string}]
intention: {score: number(0-100), level: "高"|"中"|"低", reasons: string[]}
tasks: [{item: string, status: "完成"|"未提及"|"不充分", evidence: string}]（对照任务模型逐项判定）
violations: [{item: string, evidence: string, severity: "高"|"中"|"低"}]
todos: [{what: string, due: string|null}]（从承诺事项提取，无明确日期则 null）
硬规则：
1. stance/tasks/violations 每条结论的 evidence 必须引用转写原文片段，禁止编造。
2. 违规判定必须结合配置中每项的 typical（典型话术示例）与 exemption（非违规判定说明）区分易混淆的正常话术——例如正常催签不算「诱导仓促签约」。未命中输出空数组。
3. 只输出配置中列出的竞品；mentions 为提及次数。
4. 全文无相关信息时对应字段给空数组/空串，不要硬凑。`,
  },
  meeting: {
    label: '会议纪要',
    sys: () => `你是企业内部会议纪要引擎。根据「转写文本」与「会议配置」输出严格 JSON，不要输出 JSON 以外的任何文字（包括 markdown 代码围栏）。
输出对象键及类型：
summary: string（3~5 句，按「议题→结论」结构，结论先行）
topics: [{topic: string, conclusion: string, discussion: string}]（分议题摘要：议题/结论/讨论要点）
decisions: [{what: string, owner: string, evidence: string}]（会议决议：定了什么、谁负责）
action_items: [{what: string, owner: string, due: string|null}]（行动项：事项/负责人/时限，无明确时限则 null）
disputes: [{topic: string, side_a: string, side_b: string, status: string}]（争议点：双方观点与当前状态）
open_issues: string[]（未决事项，供下次会议回顾）
attendees_hint: number（转写中出现的不同发言人数量估计）
${COMMON_RULES}
3. 区分「已达成结论」与「仅讨论未定」：前者进 decisions，后者进 open_issues，不要把讨论当决议。
4. owner 从转写内容推断（说话人N 或提到的姓名），推断不出则填空串。`,
  },
  training: {
    label: '培训·讲座',
    sys: () => `你是企业培训与讲座知识沉淀引擎。根据「转写文本」与「培训配置」输出严格 JSON，不要输出 JSON 以外的任何文字（包括 markdown 代码围栏）。
输出对象键及类型：
summary: string（讲了什么：主题/受众/主线，3~5 句）
knowledge_points: [{point: string, detail: string, evidence: string}]（知识点提炼）
qa: [{q: string, a: string}]（现场答疑整理；无提问环节则空数组）
quotes: string[]（金句/关键表述，尽量原话引用）
quiz: [{question: string, answer: string, evidence: string}]（3~5 道考核题，只考转写中的实质内容）
chapters: [{time_hint: string, title: string, gist: string}]（内容章节；转写无时间信息则 time_hint 填空串）
${COMMON_RULES}
3. 知识点按「学员能带走什么」提炼，不是逐段复述。`,
  },
  talk: {
    label: '管理谈话',
    sys: () => `你是企业管理谈话记录引擎（一对一面谈/辅导/批评谈话）。只记录事实层内容，不做评价；严禁输出情绪评分、态度打分、绩效定性或任何对「人」的判断标签。
输出严格 JSON，不要输出 JSON 以外的任何文字（包括 markdown 代码围栏）：
summary: string（中性事实表述；转写中有告知录音的内容则在开头注明「已口头告知录音」）
commitments: [{by: "管理者"|"员工", what: string, due: string|null, evidence: string}]（双向承诺并列记录：管理者的资源/支持承诺 + 员工的改进/行动承诺）
issues_discussed: string[]（讨论过的问题清单，事实层）
unresolved: string[]（未达成一致的点）
next_review: string（建议回顾时点与回顾内容；无则空串）
${COMMON_RULES}
3. 判断承诺归属（管理者/员工）以转写原文为准，归属不清则不写入。
4. 本引擎不输出 commitments/issues_discussed/unresolved 之外任何评分类字段。`,
  },
};

// ---------- Prompt（配置注入：场景专属 guide + sales 域配置） ----------
function sceneGuides(cfg, scene) {
  return (cfg.scene_profiles || [])
    .filter(p => p.enabled && (p.scene || 'sales') === scene && (p.guide || p.desc))
    .map(p => `- ${p.name}：${p.guide || p.desc || ''}`);
}
function buildMessages(transcript, cfg, scene = 'sales') {
  let configBlock = '';
  if (scene === 'sales') {
    const sections = {
      deal_model: (cfg.deal_models || []).filter(m => m.enabled).map(m => m.data?.items || []).flat(),
      task_items: (cfg.task_models || []).filter(m => m.enabled).flatMap(m => m.data?.items || []),
      competitors: (cfg.competitors || []).filter(c => c.enabled).map(c => c.name),
      violations: (cfg.violations || []).filter(v => v.enabled).map(v => ({
        item: v.name,
        trigger: v.data?.trigger || '',
        typical: v.data?.typical || '',       // 典型话术示例（ADM-018 必填）
        exemption: v.data?.exemption || '',   // 非违规判定说明（ADM-018 必填，语义判活关键）
      })),
    };
    configBlock = `【企业配置】\n${JSON.stringify(sections, null, 2)}\n\n`;
  } else {
    const guides = sceneGuides(cfg, scene);
    configBlock = guides.length ? `【场景配置】\n${guides.join('\n')}\n\n` : '';
  }
  const sys = SCENE_PROMPTS[scene].sys(cfg);
  const usr = `${configBlock}【转写文本】\n${transcript}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
}

// ---------- LLM 调用（OpenAI 兼容） ----------
async function callLLM(llmCfg, messages, scene = 'sales') {
  if (!llmCfg || !llmCfg.provider || llmCfg.provider === 'mock') return mockLLM(messages, scene);
  if (!llmCfg.base_url || !llmCfg.model || !llmCfg.api_key) {
    throw new Error('LLM 配置不全（需要 base_url / model / api_key），或在设置页切到 mock 先试管道');
  }
  const res = await fetch(llmCfg.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmCfg.api_key}` },
    body: JSON.stringify({ model: llmCfg.model, messages, temperature: 0.2 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回为空');
  return content;
}

// ---------- 本地 Mock（确定性，测管道全链路，不联网；按场景产出对应骨架） ----------
function mockLLM(messages, scene = 'sales') {
  const user = messages.find(m => m.role === 'user')?.content || '';
  const transcript = user.split('【转写文本】')[1] || user;
  const plain = transcript.replace(/\s+/g, '');
  if (scene === 'meeting') {
    const report = reportSkeleton('meeting');
    report.summary = `【Mock】会议共 ${transcript.length} 字转写，覆盖 ${plain.slice(0, 40)}…等议题。`;
    report.topics = [{ topic: '【Mock 议题】', conclusion: '【Mock】结论待真实 LLM', discussion: plain.slice(0, 60) }];
    report.decisions = [{ what: '【Mock】决议事项', owner: '', evidence: '【Mock 证据】' }];
    report.action_items = [{ what: '【Mock】行动项', owner: '', due: null }];
    report.attendees_hint = new Set((transcript.match(/说话人\d/g) || [])).size || 1;
    return '```json\n' + JSON.stringify(report) + '\n```';
  }
  if (scene === 'training') {
    const report = reportSkeleton('training');
    report.summary = `【Mock】培训/讲座转写 ${transcript.length} 字，主题：${plain.slice(0, 40)}…`;
    report.knowledge_points = [{ point: '【Mock 知识点】', detail: '【Mock】', evidence: '【Mock 证据】' }];
    report.quiz = [{ question: '【Mock】本讲核心要点是什么？', answer: '【Mock】', evidence: '【Mock 证据】' }];
    return '```json\n' + JSON.stringify(report) + '\n```';
  }
  if (scene === 'talk') {
    const report = reportSkeleton('talk');
    report.summary = `【Mock】谈话转写 ${transcript.length} 字（中性事实记录）。`;
    report.commitments = [{ by: '员工', what: '【Mock】承诺事项', due: null, evidence: '【Mock 证据】' }];
    return '```json\n' + JSON.stringify(report) + '\n```';
  }
  // sales（原逻辑不变）
  const cfg = JSON.parse((user.match(/【企业配置】\n([\s\S]*?)\n\n【转写文本】/) || [])[1] || '{}');
  const report = reportSkeleton('sales');
  report.summary = `【Mock】${plain.slice(0, 80)}（转写共 ${transcript.length} 字）`;
  report.key_facts = [{ k: 'mock', v: true }];
  report.tasks = (cfg.task_items || []).map(item => ({
    item, status: transcript.includes(item.slice(0, 2)) ? '完成' : '未提及', evidence: '【Mock 证据】',
  }));
  report.competitors = (cfg.competitors || []).map(name => {
    const mentions = transcript.split(name).length - 1;
    return { name, mentions, our_advantage: '【Mock】', risk: '【Mock】' };
  }).filter(c => c.mentions > 0);
  report.intention = { score: 50 + report.competitors.length * 10, level: '中', reasons: ['【Mock】固定评分'] };
  const todoMatch = transcript.match(/(明天|后天|下周[一二三四五六日]?|\d{1,2}月\d{1,2}日)[^，。！？]{0,20}(发|回复|汇报|给)/);
  if (todoMatch) report.todos = [{ what: todoMatch[0], due: todoMatch[1] }];
  return '```json\n' + JSON.stringify(report) + '\n```'; // 故意带围栏，走真实解析路径
}

// ---------- 解析与校验 ----------
function parseReport(raw) {
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 输出中找不到 JSON 对象');
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeReport(parsed, warnings, scene = 'sales') {
  const skel = reportSkeleton(scene);
  const report = { ...skel, ...parsed };
  if (scene === 'sales') {
    report.stance = { ...skel.stance, ...(parsed.stance || {}) };
    report.intention = { ...skel.intention, ...(parsed.intention || {}) };
  }
  // 类型兜底（LLM 偶发输出 string 而非 array）+ 清除场景骨架之外的杂散键
  for (const k of Object.keys(skel)) {
    if (Array.isArray(skel[k]) && !Array.isArray(report[k])) { warnings.push(`${k} 非数组，已重置为空`); report[k] = []; }
  }
  for (const k of Object.keys(report)) {
    if (!(k in skel) && k !== 'meta') { warnings.push(`${k} 非本场景字段，已移除`); delete report[k]; }
  }
  if (scene === 'sales') report.intention.score = Math.max(0, Math.min(100, Number(report.intention.score) || 0));
  return report;
}

/**
 * 分析一条沟通。
 * @param llmCfg {provider:'mock'|'openai-compat', base_url, model, api_key}
 * @param transcript 转写全文
 * @param cfg 企业配置 {deal_models, task_models, competitors, violations, analysis_dims, scene_profiles}
 * @param scene 'sales'|'meeting'|'training'|'talk'（09 册 INT-10；未知值回落 sales）
 * @returns 报告对象（含 meta）
 */
async function analyzeCommunication(llmCfg, transcript, cfg, scene = 'sales') {
  const sc = SCENES.includes(scene) ? scene : 'sales';
  const warnings = [];
  const messages = buildMessages(transcript || '（空转写）', cfg || {}, sc);
  const raw = await callLLM(llmCfg, messages, sc);
  let report = normalizeReport(parseReport(raw), warnings, sc);
  report = redactDeep(report); // CMP-07：输出层脱敏（入库层已脱敏，此为第二层防御）
  report.meta = {
    model: llmCfg?.provider === 'mock' ? 'mock' : `${llmCfg?.model || '?'}`,
    scene: sc,
    generated_at: new Date().toISOString(),
    ai_generated: true, // CMP-17：前端必须渲染 AI 生成标识
    warnings,
  };
  return report;
}

module.exports = { analyzeCommunication, buildMessages, parseReport, normalizeReport, reportSkeleton, SCENES };

// ---------- CLI 自测：node analysis.js ----------
if (require.main === module) {
  const salesCfg = {
    analysis_dims: [], task_models: [{ name: '标准', enabled: true, data: { items: ['需求挖掘', '报价', '邀约跟进'] } }],
    competitors: [{ name: '竞品A', enabled: true }],
    violations: [{ name: '诱导仓促签约', enabled: true, data: { typical: '今天不签就没优惠了', exemption: '正常告知活动截止时间不算' } }],
    scene_profiles: [{ name: '周会口径', enabled: true, scene: 'meeting', guide: '输出口径面向全员公开' }],
  };
  const samples = {
    sales: `说话人1: 您好，欢迎光临，我是销售顾问小王。
说话人2: 你好，我想看看你们的新款，另外也对比了竞品A，感觉价格差不多。
说话人1: 咱们这款本月有活动，明天我把详细方案发您邮箱，您预算大概多少？
说话人2: 预算二十万以内吧，回去和家人商量一下再定。`,
    meeting: `说话人1: 下面开周会。第一件事，版本发布定在下周三，谁负责？
说话人2: 我来负责发布。另外测试资源还不够，希望管理者协调。
说话人1: 好，下周一起调两个人过去。预算的事这次先不定，下次再议。
说话人3: 我反对这个时间，太赶了。
说话人1: 时间保持不变，散会。`,
    training: `讲师: 今天讲需求挖掘的三个方法。第一，开放式提问……大家记住这句话："先听全，再追问"。
学员: 老师，客户不配合怎么办？
讲师: 用场景代入法，先给客户讲同行业的案例。`,
    talk: `管理者: 这次方案延期的事，跟你聊聊，录音我先告知你一下。
员工: 好的，延期主要是我排期低估了。
管理者: 下周起每周五给我提交进度周报，我也会协调测试组给你支援。
员工: 行，我承诺下周三之前把延期模块补上。`,
  };
  (async () => {
    let fail = 0;
    for (const scene of SCENES) {
      const r = await analyzeCommunication({ provider: 'mock' }, samples[scene], salesCfg, scene);
      const skel = reportSkeleton(scene);
      const missing = Object.keys(skel).filter(k => !(k in r));
      console.log(`===== [${scene}] Mock 分析报告 =====`);
      console.log(JSON.stringify(r, null, 2).slice(0, 400) + ' …');
      if (missing.length) { console.error(`  ✗ [${scene}] 缺字段:`, missing); fail = 1; continue; }
      if (r.meta.scene !== scene || r.meta.ai_generated !== true) { console.error(`  ✗ [${scene}] meta 异常`); fail = 1; continue; }
      // 红线（09 册 K5）：talk 报告不得出现评分类字段
      if (scene === 'talk') {
        const bad = ['emotion', 'attitude', 'score', 'rating', '情绪', '态度'].filter(k => k in r);
        if (bad.length) { console.error(`  ✗ [talk] 出现红线字段:`, bad); fail = 1; continue; }
      }
      // 场景隔离：sales 报告不得混入 meeting 字段（normalizeReport 杂散键清理）
      if (scene === 'sales' && ('decisions' in r || 'knowledge_points' in r)) { console.error('  ✗ [sales] 混入其他场景字段'); fail = 1; continue; }
      // Mock 按场景产出实质内容（防 callLLM 漏传 scene 落回 sales Mock 的回归）
      const mockCheck = {
        meeting: r => r.decisions?.length >= 1 && r.action_items?.length >= 1,
        training: r => r.knowledge_points?.length >= 1 && r.quiz?.length >= 1,
        talk: r => r.commitments?.length >= 1,
        sales: r => (r.tasks || []).length >= 1,
      }[scene];
      if (!mockCheck(r)) { console.error(`  ✗ [${scene}] Mock 未按场景产出内容`); fail = 1; continue; }
      console.log(`  ✓ [${scene}] 骨架完整 / meta 场景标记 / AI 标识`);
    }
    // 配置注入检查：scene_profiles guide 进入 meeting prompt，sales 配置不受影响
    const m = buildMessages(samples.meeting, salesCfg, 'meeting');
    if (!m[1].content.includes('周会口径')) { console.error('  ✗ [meeting] scene_profiles 未注入'); fail = 1; }
    else console.log('  ✓ scene_profiles 场景配置注入');
    const s = buildMessages(samples.sales, salesCfg, 'sales');
    if (!s[1].content.includes('竞品A')) { console.error('  ✗ [sales] 域配置未注入'); fail = 1; }
    else console.log('  ✓ sales 域配置注入（回归）');
    process.exit(fail);
  })().catch(e => { console.error('自测失败:', e); process.exit(1); });
}
