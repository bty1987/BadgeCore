/**
 * BadgeCore 沟通分析管道（06 册 AI-04~06/10，D8 违规判活）
 * -------------------------------------------------------
 * 输入：转写文本（可含"说话人N:"轮次）+ 企业配置（成交模型/任务模型/竞品库/违规项）
 * 输出：结构化报告 JSON（摘要/关键信息/立场/竞品/意向度/任务达成/违规/待办）
 *
 * LLM 供应商：OpenAI 兼容 /chat/completions（GLM/DeepSeek/Qwen 均兼容），配置在后台「设置」页；
 * provider=mock 时用本地确定性 Mock（测试管道用，不调网络）。
 * 所有报告带 meta.ai_generated=true（07 册 CMP-17 AI 生成标识）。
 */

// ---------- 报告骨架 ----------
function reportSkeleton() {
  return {
    summary: '',
    key_facts: [],                    // ANA-01 [{k, v}]
    stance: { support: [], concerns: [], unmentioned: [] }, // ANA-03
    competitors: [],                  // ANA-04 [{name, mentions, our_advantage, risk}]
    intention: { score: 0, level: '低', reasons: [] },        // ANA-05
    tasks: [],                        // ANA-06 [{item, status: 完成|未提及|不充分, evidence}]
    violations: [],                   // ANA-08 [{item, evidence, severity}]
    todos: [],                        // ANA-10 [{what, due}]
  };
}

// ---------- Prompt（06 册 3.2：配置注入 + JSON Schema 约束 + 原文可溯源） ----------
function buildMessages(transcript, cfg) {
  const dims = new Set((cfg.analysis_dims || []).map(d => d.key));
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
  const sys = `你是企业销售沟通分析引擎。根据「转写文本」与「企业配置」输出严格 JSON，不要输出 JSON 以外的任何文字（包括 markdown 代码围栏）。
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
4. 全文无相关信息时对应字段给空数组/空串，不要硬凑。`;
  const usr = `【企业配置】
${JSON.stringify(sections, null, 2)}

【转写文本】
${transcript}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
}

// ---------- LLM 调用（OpenAI 兼容） ----------
async function callLLM(llmCfg, messages) {
  if (!llmCfg || !llmCfg.provider || llmCfg.provider === 'mock') return mockLLM(messages);
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

// ---------- 本地 Mock（确定性，测管道全链路，不联网） ----------
function mockLLM(messages) {
  const user = messages.find(m => m.role === 'user')?.content || '';
  const transcript = user.split('【转写文本】')[1] || user;
  const cfg = JSON.parse((user.match(/【企业配置】\n([\s\S]*?)\n\n【转写文本】/) || [])[1] || '{}');
  const report = reportSkeleton();
  report.summary = `【Mock】${transcript.replace(/\s+/g, '').slice(0, 80)}（转写共 ${transcript.length} 字）`;
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

function normalizeReport(parsed, warnings) {
  const skel = reportSkeleton();
  const report = { ...skel, ...parsed };
  report.stance = { ...skel.stance, ...(parsed.stance || {}) };
  report.intention = { ...skel.intention, ...(parsed.intention || {}) };
  // 类型兜底（LLM 偶发输出 string 而非 array）
  for (const k of ['key_facts', 'competitors', 'tasks', 'violations', 'todos']) {
    if (!Array.isArray(report[k])) { warnings.push(`${k} 非数组，已重置为空`); report[k] = []; }
  }
  report.intention.score = Math.max(0, Math.min(100, Number(report.intention.score) || 0));
  return report;
}

/**
 * 分析一条沟通。
 * @param llmCfg {provider:'mock'|'openai-compat', base_url, model, api_key}
 * @param transcript 转写全文
 * @param cfg 企业配置 {deal_models, task_models, competitors, violations, analysis_dims}
 * @returns 报告对象（含 meta）
 */
async function analyzeCommunication(llmCfg, transcript, cfg) {
  const warnings = [];
  const messages = buildMessages(transcript || '（空转写）', cfg || {});
  const raw = await callLLM(llmCfg, messages);
  const report = normalizeReport(parseReport(raw), warnings);
  report.meta = {
    model: llmCfg?.provider === 'mock' ? 'mock' : `${llmCfg?.model || '?'}`,
    generated_at: new Date().toISOString(),
    ai_generated: true, // CMP-17：前端必须渲染 AI 生成标识
    warnings,
  };
  return report;
}

module.exports = { analyzeCommunication, buildMessages, parseReport, normalizeReport };

// ---------- CLI 自测：node analysis.js ----------
if (require.main === module) {
  const sampleTranscript = `说话人1: 您好，欢迎光临，我是销售顾问小王。
说话人2: 你好，我想看看你们的新款，另外也对比了竞品A，感觉价格差不多。
说话人1: 咱们这款本月有活动，明天我把详细方案发您邮箱，您预算大概多少？
说话人2: 预算二十万以内吧，回去和家人商量一下再定。`;
  const sampleCfg = {
    analysis_dims: [], task_models: [{ name: '标准', enabled: true, data: { items: ['需求挖掘', '报价', '邀约跟进'] } }],
    competitors: [{ name: '竞品A', enabled: true }],
    violations: [{ name: '诱导仓促签约', enabled: true, data: { typical: '今天不签就没优惠了', exemption: '正常告知活动截止时间不算' } }],
  };
  analyzeCommunication({ provider: 'mock' }, sampleTranscript, sampleCfg)
    .then(r => {
      console.log('===== Mock 分析报告 =====');
      console.log(JSON.stringify(r, null, 2));
      const must = ['summary', 'key_facts', 'stance', 'competitors', 'intention', 'tasks', 'violations', 'todos', 'meta'];
      const missing = must.filter(k => !(k in r));
      if (missing.length) { console.error('缺字段:', missing); process.exit(1); }
      if (r.meta.ai_generated !== true) { console.error('缺 AI 生成标识'); process.exit(1); }
      if (!r.tasks.length || r.tasks[0].item !== '需求挖掘') { console.error('任务模型未注入'); process.exit(1); }
      if (r.competitors[0]?.name !== '竞品A' || r.competitors[0]?.mentions !== 1) { console.error('竞品计数错误'); process.exit(1); }
      if (!r.todos.length) { console.error('待办提取失败'); process.exit(1); }
      console.log('\n自测通过：骨架完整 / 配置注入 / 竞品计数 / 待办提取 / AI 标识');
    })
    .catch(e => { console.error('自测失败:', e); process.exit(1); });
}
