/**
 * BadgeCore 管理后台服务（04 册核心域 + 03 册沟通记录/报告，D13 零依赖栈）
 * ----------------------------------------------------------------------
 * Node 内置 http + node:sqlite + 原生 fetch；前端为 public/ 静态页（无构建步骤）。
 *
 * 启动：node server/index.js   （环境变量 PORT/DB_FILE/INGEST_TOKEN 可覆盖）
 * 首次启动：自动建库、种子管理员 admin/admin123（登录后请改密）、生成入库令牌。
 *
 * 主要 API（除 /api/login 与 /api/ingest 外均需登录 Cookie）：
 *   POST /api/login | GET /api/me | POST /api/logout
 *   GET  /api/communications[?q=&status=]        列表（sales 仅本人）
 *   GET  /api/communications/:id                 详情（转写+报告）
 *   DEL  /api/communications/:id                 删除（审计）
 *   POST /api/communications/:id/analyze         触发/重跑分析
 *   POST /api/ingest  (X-Ingest-Token)           receiver 推送会话（录音+转写）
 *   GET/PUT /api/settings                        全局配置（含 LLM；Key 只写不读）
 *   POST /api/llm-test                           用当前 LLM 配置跑样例分析
 *   GET/POST/PUT/DELETE /api/config/:domain[/:id] 九大域 CRUD（admin）
 *   GET /api/users | POST /api/users             用户管理（admin）
 *   GET /api/audit                               审计日志（admin）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb, getSetting, setSetting, audit } = require('./db');
const { analyzeCommunication } = require('./analysis');
const { judgeAttendance, periodsToDaily } = require('./attendance');
const { redactText } = require('./redact');
const { runRetentionPurge, loadRetention, MIN: RETENTION_MIN } = require('./retention');

const PORT = Number(process.env.PORT || 8200);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'badgecore.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DOMAINS = [ // 04 册沟通配置九大域（ADM-01x）+ 知识库/案例库/风险规则/定时报告（04 册 §2 菜单）
  'info_fields', 'deal_models', 'task_models', 'ability_models',
  'summary_templates', 'analysis_dims', 'flows', 'violations', 'competitors',
  'knowledge_base', 'case_library', 'risk_rules', 'scheduled_reports',
];
const SESSION_TTL = 12 * 3600 * 1000;

const db = openDb(DB_FILE);
const sessions = new Map(); // token → {name, role, expires}

// ---------- 初始化：管理员种子 + 入库令牌 + 默认设置 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function seed() {
  const hasAdmin = db.prepare('SELECT COUNT(*) c FROM users WHERE role=?').get('admin').c > 0;
  if (!hasAdmin) {
    const salt = crypto.randomBytes(12).toString('hex');
    db.prepare('INSERT INTO users(name, pass_hash, salt, role, created_at) VALUES(?,?,?,?,?)')
      .run('admin', hashPassword('admin123', salt), salt, 'admin', new Date().toISOString());
    console.log('[初始化] 已创建管理员 admin / admin123（首次登录后请修改密码）');
  }
  if (!getSetting(db, 'ingest_token')) {
    const token = crypto.randomBytes(16).toString('hex');
    setSetting(db, 'ingest_token', token);
  }
  if (!getSetting(db, 'llm')) {
    // 默认 mock 自动分析：开箱即可演示全链路；换真实供应商在「设置」页
    setSetting(db, 'llm', { provider: 'mock', base_url: '', model: '', api_key: '', auto: true });
  }
  if (!db.prepare('SELECT COUNT(*) c FROM config_items WHERE domain=?').get('violations').c) {
    db.prepare('INSERT INTO config_items(domain, name, enabled, data, updated_at) VALUES(?,?,?,?,?)')
      .run('violations', '示例·诱导仓促签约', 1, JSON.stringify({
        trigger: '利用信息差施压使客户仓促签约',
        typical: '今天不签这个优惠就没了，别考虑了直接定吧',
        exemption: '正常告知活动截止日期、留时间考虑的不算诱导',
      }), new Date().toISOString());
  }
}

// ---------- 会话与鉴权 ----------
function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [k, v] = pair.trim().split('=');
    if (k) out[k] = decodeURIComponent(v || '');
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req).badge_token;
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) return null;
  s.expires = Date.now() + SESSION_TTL; // 滑动续期
  return s;
}

// ---------- HTTP 工具 ----------
function sendJson(res, code, obj, setCookie) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
  });
  res.end(body);
}
function readBody(req, limit = 20 * 1024 * 1024) { // 转写文本可能较大
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- 业务逻辑 ----------
/** 实时辅助·规则预筛（AI-09 一期）：竞品提及 + 风险词命中，入库时计算并随 meta 下发 */
function computeAlerts(transcript) {
  const alerts = [];
  for (const c of db.prepare('SELECT name FROM config_items WHERE domain=? AND enabled=1').all('competitors')) {
    if (transcript.includes(c.name)) alerts.push({ type: 'competitor', word: c.name, level: 'mid' });
  }
  for (const r of db.prepare('SELECT name, data FROM config_items WHERE domain=? AND enabled=1').all('risk_rules')) {
    const d = JSON.parse(r.data || '{}');
    for (const kw of d.keywords || []) {
      if (transcript.includes(kw)) alerts.push({ type: 'risk', word: kw, rule: r.name, level: d.level || 'high' });
    }
  }
  return alerts;
}

/** Ask AI 检索（AI-08 简版 RAG，内部使用：滑窗关键词匹配，不依赖向量库） */
function extractTerms(q) {
  const stop = new Set(['什么', '怎么', '哪些', '请问', '一下', '关于', '最近', '情况', '我们', '他们', '这个', '那个', '如何', '为什么', '多少']);
  const terms = new Set();
  const clean = q.replace(/[？?！!。，,\s]/g, '');
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i + len <= clean.length; i++) {
      const s = clean.slice(i, i + len);
      if (!stop.has(s)) terms.add(s);
    }
  }
  return [...terms].slice(0, 40);
}
function searchCommunications(question, scopeSql, scopeParams) {
  const terms = extractTerms(question);
  const rows = db.prepare(`SELECT id, created_at, topic, transcript, report FROM communications ${scopeSql} ORDER BY id DESC LIMIT 300`).all(...scopeParams);
  return rows.map(r => {
    const hay = `${r.topic}\n${r.transcript || ''}\n${r.report || ''}`;
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score++;
    return { ...r, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

/** Ask AI 核心（AI-08）：权限内检索 → LLM/Mock 回答（/api/ask 与 AI-11 定时任务复用） */
async function answerQuestion(role, name, question) {
  const scopeSql = role === 'sales' ? 'WHERE owner=?' : '';
  const scopeParams = role === 'sales' ? [name] : [];
  const comms = searchCommunications(String(question), scopeSql, scopeParams);
  const kbs = db.prepare("SELECT name, data FROM config_items WHERE domain='knowledge_base' AND enabled=1 ORDER BY sort,id").all()
    .map(r => ({ name: r.name, ...JSON.parse(r.data || '{}') }));
  const cases = db.prepare("SELECT name, data FROM config_items WHERE domain='case_library' AND enabled=1 ORDER BY sort,id").all()
    .map(r => ({ name: r.name, ...JSON.parse(r.data || '{}') }));
  const sources = [
    ...comms.map((c, i) => ({ n: i + 1, type: 'comm', id: c.id, title: `沟通#${c.id} ${c.topic || ''}`, snippet: (c.transcript || '').slice(0, 120) })),
    ...kbs.map((k, i) => ({ n: comms.length + i + 1, type: 'kb', id: 0, title: `知识库·${k.name}`, snippet: String(k.content || k.desc || '').slice(0, 120) })),
    ...cases.map((c, i) => ({ n: comms.length + kbs.length + i + 1, type: 'case', id: 0, title: `案例·${c.name}`, snippet: String(c.script || c.content || '').slice(0, 120) })),
  ];
  const llm = getSetting(db, 'llm');
  let answer;
  if (!llm || llm.provider === 'mock') {
    answer = `【Mock】在${role === 'sales' ? '你名下' : '全企业'}数据范围内检索到 ${comms.length} 条相关沟通、知识库 ${kbs.length} 条、案例 ${cases.length} 条。` +
      (sources.length ? `最相关：${sources[0].title}（${sources[0].snippet}…）。配置真实 LLM 后可获得基于以上来源的综合回答。` : '未检索到相关内容，可尝试更换关键词。');
  } else {
    const context = sources.map(s => `[${s.n}] ${s.title}\n${s.snippet}`).join('\n\n');
    const messages = [
      { role: 'system', content: '你是企业沟通数据问答助手（SalesCoach 视角）。只依据下方【检索来源】回答；每个事实结论标注来源编号如 [1]；来源不足以回答时明确说明，禁止编造；不透露来源之外的其他员工数据。回答用中文，简洁分点。' },
      { role: 'user', content: `【检索来源】\n${context}\n\n【问题】${question}` },
    ];
    const raw = await fetch(llm.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
      body: JSON.stringify({ model: llm.model, messages, temperature: 0.2 }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!raw.ok) throw new HttpError(502, `LLM HTTP ${raw.status}`);
    const d = await raw.json();
    answer = d.choices?.[0]?.message?.content || '(空回答)';
  }
  return { answer, sources };
}

/** 访前准备智能体（AI-10）：客户背景/行业动态/产品匹配/准备问题清单 */
async function prepVisitPlan(role, name, customer, notes) {
  const { answer } = await answerQuestion(role, name, `${customer} ${notes || ''}`); // 复用检索作上下文来源
  const llm = getSetting(db, 'llm');
  const kbs = db.prepare("SELECT name FROM config_items WHERE domain='knowledge_base' AND enabled=1").all();
  const comms = searchCommunications(customer, role === 'sales' ? 'WHERE owner=?' : '', role === 'sales' ? [name] : []);
  if (!llm || llm.provider === 'mock') {
    return {
      customer: customer || '(未填)',
      background: `【Mock】检索到该客户相关沟通 ${comms.length} 条；知识库 ${kbs.length} 条可作资料底座。`,
      industry: '【Mock】行业动态需接入真实 LLM 联网检索后生成。',
      match: kbs.slice(0, 3).map(k => `可引用知识：${k.name}`).join('；') || '【Mock】知识库为空，建议先在配置页补充产品知识。',
      questions: ['客户目前最关注什么？', '上次沟通遗留了什么未解决项？', '本次要拿到什么承诺/下一步？'],
      note: answer.slice(0, 100),
    };
  }
  const messages = [
    { role: 'system', content: '你是销售访前准备智能体。依据【上下文】输出严格 JSON：{background, industry, match, questions:[string]}, 只输出 JSON。' },
    { role: 'user', content: `【上下文】\n${answer}\n\n【客户】${customer}\n【备注】${notes || '无'}` },
  ];
  const raw = await fetch(llm.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
    body: JSON.stringify({ model: llm.model, messages, temperature: 0.3 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!raw.ok) throw new HttpError(502, `LLM HTTP ${raw.status}`);
  const d = await raw.json();
  const plan = JSON.parse(String(d.choices?.[0]?.message?.content || '{}').replace(/```(?:json)?|```/g, '').trim());
  return { customer: customer || '(未填)', ...plan };
}

function loadAnalysisConfig() {
  const cfg = {};
  for (const domain of ['deal_models', 'task_models', 'competitors', 'violations', 'analysis_dims']) {
    cfg[domain] = db.prepare('SELECT name, enabled, data FROM config_items WHERE domain=? ORDER BY sort, id').all(domain)
      .map(r => ({ name: r.name, enabled: !!r.enabled, ...(JSON.parse(r.data || '{}')) }));
  }
  return cfg;
}

async function runAnalysis(commId, actor) {
  const row = db.prepare('SELECT * FROM communications WHERE id=?').get(commId);
  if (!row) throw new HttpError(404, '沟通记录不存在');
  const llm = getSetting(db, 'llm');
  db.prepare('UPDATE communications SET status=? WHERE id=?').run('analyzing', commId);
  try {
    const report = await analyzeCommunication(llm, row.transcript || '', loadAnalysisConfig());
    db.prepare('UPDATE communications SET report=?, status=? WHERE id=?')
      .run(JSON.stringify(report), 'analyzed', commId);
    audit(db, actor, 'analyze', `comm#${commId}`, `model=${report.meta.model}`);
    return report;
  } catch (e) {
    db.prepare('UPDATE communications SET status=? WHERE id=?').run('failed', commId);
    throw e;
  }
}

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // 公开端点：登录
  if (pathname === '/api/login' && method === 'POST') {
    const { name, password } = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE name=? AND active=1').get(String(name || ''));
    if (!u || u.pass_hash !== hashPassword(String(password || ''), u.salt)) {
      audit(db, String(name || '?'), 'login_failed');
      throw new HttpError(401, '账号或密码错误');
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { name: u.name, role: u.role, expires: Date.now() + SESSION_TTL });
    audit(db, u.name, 'login');
    return sendJson(res, 200, { ok: true, name: u.name, role: u.role },
      `badge_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
  }

  // 公开端点：receiver 入库（令牌鉴权）
  if (pathname === '/api/ingest' && method === 'POST') {
    const expect = getSetting(db, 'ingest_token');
    const got = req.headers['x-ingest-token'] || (await readBody(req)).token;
    if (!expect || got !== expect) throw new HttpError(401, '入库令牌无效');
    const b = await readBody(req);
    const transcript = redactText(String(b.transcript || '')); // CMP-07：入库即脱敏（LLM/检索不接触明文）
    const info = db.prepare('INSERT INTO communications(created_at, duration_s, audio_path, transcript, status, owner, topic, meta) VALUES(?,?,?,?,?,?,?,?)')
      .run(
        b.created_at || new Date().toISOString(),
        Number(b.duration_s) || 0,
        String(b.audio_path || ''),
        transcript,
        transcript ? 'transcribed' : 'recorded',
        String(b.owner || ''),
        String(b.topic || ''),
        JSON.stringify({ device: b.device || '', source: b.source || 'receiver' }),
      );
    const id = Number(info.lastInsertRowid);
    audit(db, 'receiver', 'ingest', `comm#${id}`, `${Number(b.duration_s) || 0}s`);
    // 实时辅助·规则预筛（AI-09）：竞品/风险词命中随记录下发并告警
    const alerts = computeAlerts(transcript);
    if (alerts.length) {
      db.prepare('UPDATE communications SET meta=? WHERE id=?')
        .run(JSON.stringify({ device: b.device || '', source: b.source || 'receiver', alerts }), id);
      for (const a of alerts) audit(db, 'rule_engine', 'risk_alert', `comm#${id}`, `${a.type}:${a.word}`);
    }
    const llm = getSetting(db, 'llm');
    if (llm.auto && transcript) {
      try { await runAnalysis(id, 'auto'); return sendJson(res, 200, { id, analyzed: true }); }
      catch (e) { return sendJson(res, 200, { id, analyzed: false, error: e.message }); }
    }
    return sendJson(res, 200, { id });
  }

  // 以下端点需登录
  const me = currentUser(req);
  if (!me) throw new HttpError(401, '未登录');

  if (pathname === '/api/logout' && method === 'POST') {
    sessions.delete(parseCookies(req).badge_token);
    return sendJson(res, 200, { ok: true }, 'badge_token=; Path=/; Max-Age=0');
  }
  if (pathname === '/api/me') return sendJson(res, 200, { name: me.name, role: me.role });

  // 沟通记录
  let m;
  if ((m = pathname.match(/^\/api\/communications$/)) && method === 'GET') {
    const { q = '', status = '' } = Object.fromEntries(url.searchParams);
    let sql = 'SELECT id, created_at, duration_s, status, owner, topic, report FROM communications';
    const where = []; const params = [];
    if (me.role === 'sales') { where.push('owner=?'); params.push(me.name); } // ADM-313 数据范围（sales=本人）
    if (status) { where.push('status=?'); params.push(status); }
    if (q) { where.push('(topic LIKE ? OR transcript LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT 500';
    const rows = db.prepare(sql).all(...params).map(r => {
      const report = r.report ? JSON.parse(r.report) : null;
      return { ...r, report: undefined, summary: report?.summary || '', intention: report?.intention || null };
    });
    return sendJson(res, 200, rows);
  }
  if ((m = pathname.match(/^\/api\/communications\/(\d+)$/))) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM communications WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '沟通记录不存在');
    if (me.role === 'sales' && row.owner !== me.name) throw new HttpError(403, '无权查看该记录');
    if (method === 'GET') {
      row.report = row.report ? JSON.parse(row.report) : null;
      row.meta = JSON.parse(row.meta || '{}');
      return sendJson(res, 200, row);
    }
    if (method === 'DELETE' && me.role !== 'sales') {
      db.prepare('DELETE FROM communications WHERE id=?').run(id);
      audit(db, me.name, 'delete_comm', `comm#${id}`);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, '方法不支持');
  }
  if ((m = pathname.match(/^\/api\/communications\/(\d+)\/analyze$/)) && method === 'POST') {
    const report = await runAnalysis(Number(m[1]), me.name);
    return sendJson(res, 200, { ok: true, report });
  }

  // 导出（CMP-13：水印=访问者+时间，写审计）
  if ((m = pathname.match(/^\/api\/communications\/(\d+)\/export$/)) && method === 'GET') {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM communications WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '沟通记录不存在');
    if (me.role === 'sales' && row.owner !== me.name) throw new HttpError(403, '无权导出该记录');
    const report = row.report ? JSON.parse(row.report) : null;
    const text = [
      'BadgeCore 沟通记录导出',
      `【水印】导出人: ${me.name}（${me.role}）  时间: ${new Date().toLocaleString('zh-CN')}  本次导出已记入审计日志`,
      '='.repeat(60),
      `主题: ${row.topic || '(未命名)'}  时间: ${row.created_at}  时长: ${row.duration_s}s  归属: ${row.owner || '-'}`,
      '',
      '── 转写全文（已脱敏 CMP-07）──',
      row.transcript || '(无/已过留存期)',
      '',
      '── AI 分析报告 ──',
      report ? JSON.stringify(report, null, 2) : '(未生成/已过留存期)',
      '',
      '以上内容由 AI 生成，仅供参考。',
    ].join('\n');
    audit(db, me.name, 'export', `comm#${id}`, '水印导出');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="badgecore-comm-${id}.txt"`,
    });
    return res.end(text);
  }

  // 设置（LLM Key 只写不读，07 册 CMP-12 最小暴露；留存 CMP-08）
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const llm = getSetting(db, 'llm');
      const token = getSetting(db, 'ingest_token');
      return sendJson(res, 200, {
        llm: { ...llm, api_key: undefined, has_api_key: !!llm.api_key },
        retention: loadRetention(db),
        ingest_token: me.role === 'admin' ? token : undefined,
      });
    }
    if (method === 'PUT' && me.role === 'admin') {
      const b = await readBody(req);
      if (b.llm) {
        const old = getSetting(db, 'llm');
        const next = {
          provider: ['mock', 'openai-compat'].includes(b.llm.provider) ? b.llm.provider : 'mock',
          base_url: String(b.llm.base_url || '').trim(),
          model: String(b.llm.model || '').trim(),
          api_key: b.llm.api_key ? String(b.llm.api_key).trim() : old.api_key, // 留空=不改
          auto: b.llm.auto !== false,
        };
        setSetting(db, 'llm', next);
        audit(db, me.name, 'set_llm', `provider=${next.provider} model=${next.model}`);
      }
      if (b.retention) { // CMP-08：不得低于建议下限
        const r = b.retention;
        for (const k of Object.keys(RETENTION_MIN)) {
          if (Number(r[k]) && Number(r[k]) < RETENTION_MIN[k]) {
            throw new HttpError(400, `留存天数不得低于建议期：${k} ≥ ${RETENTION_MIN[k]} 天（07 册 CMP-08）`);
          }
        }
        setSetting(db, 'retention', {
          audio_days: Number(r.audio_days) || RETENTION_MIN.audio_days,
          transcript_days: Number(r.transcript_days) || RETENTION_MIN.transcript_days,
          report_days: Number(r.report_days) || RETENTION_MIN.report_days,
        });
        audit(db, me.name, 'set_retention', JSON.stringify(r));
      }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(403, '仅管理员可改设置');
  }
  if (pathname === '/api/settings/purge' && method === 'POST' && me.role === 'admin') {
    const result = runRetentionPurge(db);
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/llm-test' && method === 'POST') {
    const llm = getSetting(db, 'llm');
    try {
      const r = await analyzeCommunication(llm, '说话人1: 这是连通性测试。说话人2: 收到，明天我把资料发您。', loadAnalysisConfig());
      return sendJson(res, 200, { ok: true, model: r.meta.model, summary: r.summary, todos: r.todos });
    } catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }

  // 九大域配置 CRUD（admin）
  if ((m = pathname.match(/^\/api\/config\/(\w+)(?:\/(\d+))?$/)) && CONFIG_DOMAINS.includes(m[1])) {
    const domain = m[1]; const id = m[2] ? Number(m[2]) : null;
    if (me.role !== 'admin') throw new HttpError(403, '仅管理员可管理配置');
    if (method === 'GET' && !id) {
      const rows = db.prepare('SELECT id, name, enabled, sort, data FROM config_items WHERE domain=? ORDER BY sort, id').all(domain)
        .map(r => ({ ...r, data: JSON.parse(r.data || '{}') }));
      return sendJson(res, 200, rows);
    }
    if (method === 'POST' && !id) {
      const b = await readBody(req);
      const r = db.prepare('INSERT INTO config_items(domain, name, enabled, sort, data, updated_at) VALUES(?,?,?,?,?,?)')
        .run(domain, String(b.name || '未命名'), b.enabled === false ? 0 : 1, Number(b.sort) || 0,
          JSON.stringify(b.data || {}), new Date().toISOString());
      audit(db, me.name, 'config_create', `${domain}#${r.lastInsertRowid}`, b.name);
      return sendJson(res, 200, { id: Number(r.lastInsertRowid) });
    }
    if (method === 'PUT' && id) {
      const b = await readBody(req);
      db.prepare('UPDATE config_items SET name=?, enabled=?, sort=?, data=?, updated_at=? WHERE id=? AND domain=?')
        .run(String(b.name || '未命名'), b.enabled === false ? 0 : 1, Number(b.sort) || 0,
          JSON.stringify(b.data || {}), new Date().toISOString(), id, domain);
      audit(db, me.name, 'config_update', `${domain}#${id}`, b.name);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM config_items WHERE id=? AND domain=?').run(id, domain);
      audit(db, me.name, 'config_delete', `${domain}#${id}`);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, '方法不支持');
  }

  // 用户管理（admin）
  if (pathname === '/api/users') {
    if (me.role !== 'admin') throw new HttpError(403, '仅管理员');
    if (method === 'GET') {
      return sendJson(res, 200, db.prepare('SELECT id, name, role, active, created_at FROM users ORDER BY id').all());
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.password) throw new HttpError(400, '需要 name/password');
      const salt = crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT INTO users(name, pass_hash, salt, role, created_at) VALUES(?,?,?,?,?)')
        .run(String(b.name), hashPassword(String(b.password), salt), salt,
          ['admin', 'manager', 'sales'].includes(b.role) ? b.role : 'sales', new Date().toISOString());
      audit(db, me.name, 'user_create', String(b.name), `role=${b.role}`);
      return sendJson(res, 200, { ok: true });
    }
  }
  if ((m = pathname.match(/^\/api\/users\/(\d+)\/(disable|enable|resetpass)$/)) && me.role === 'admin' && method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'resetpass') {
      const b = await readBody(req);
      const salt = crypto.randomBytes(12).toString('hex');
      db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hashPassword(String(b.password || ''), salt), salt, id);
      audit(db, me.name, 'user_resetpass', `user#${id}`);
      return sendJson(res, 200, { ok: true });
    }
    db.prepare('UPDATE users SET active=? WHERE id=?').run(m[2] === 'enable' ? 1 : 0, id);
    audit(db, me.name, `user_${m[2]}`, `user#${id}`);
    return sendJson(res, 200, { ok: true });
  }

  // 审计（admin，ADM-315）
  if (pathname === '/api/audit' && method === 'GET') {
    if (me.role !== 'admin') throw new HttpError(403, '仅管理员');
    return sendJson(res, 200, db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all());
  }

  // Ask AI（AI-08 简版 RAG：检索范围随数据权限，来源强制引用）
  if (pathname === '/api/ask' && method === 'POST') {
    const { question } = await readBody(req);
    if (!question || String(question).length < 2) throw new HttpError(400, '问题太短');
    const { answer, sources } = await answerQuestion(me.role, me.name, String(question));
    audit(db, me.name, 'ask', '', String(question).slice(0, 80));
    return sendJson(res, 200, { answer, sources, ai_generated: true });
  }

  // 访前准备智能体（AI-10）
  if (pathname === '/api/prep-visit' && method === 'POST') {
    const { customer, notes } = await readBody(req);
    if (!customer) throw new HttpError(400, '需要 customer');
    const plan = await prepVisitPlan(me.role, me.name, String(customer), String(notes || ''));
    audit(db, me.name, 'prep_visit', String(customer));
    return sendJson(res, 200, { plan, ai_generated: true });
  }

  // 站内信（AI-11 投递箱）
  if (pathname === '/api/notifications' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM notifications WHERE user=? ORDER BY id DESC LIMIT 100').all(me.name);
    const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user=? AND read=0').get(me.name).c;
    return sendJson(res, 200, { unread, rows });
  }
  if (pathname === '/api/notifications/read' && method === 'POST') {
    db.prepare('UPDATE notifications SET read=1 WHERE user=? AND (read=0)').run(me.name);
    return sendJson(res, 200, { ok: true });
  }

  // 定时报告：手动触发一次（AI-11；调度器每分钟自动检查，此端点供验证/运维）
  if (pathname === '/api/scheduled/run' && method === 'POST') {
    if (me.role !== 'admin') throw new HttpError(403, '仅管理员');
    const b = await readBody(req);
    const item = db.prepare('SELECT * FROM config_items WHERE domain=? AND id=?').get('scheduled_reports', Number(b.id));
    if (!item) throw new HttpError(404, '定时任务不存在');
    await fireScheduledItem(item, true);
    return sendJson(res, 200, { ok: true });
  }

  // 考勤（05 册 ALL-201/202；CMP-09 与沟通数据分域，HR 角色仅经此接口触达考勤）
  if (pathname === '/api/attendance' && method === 'POST') { // 手动补卡（ALL-202）
    const b = await readBody(req);
    if (!b.user || !b.date) throw new HttpError(400, '需要 user/date');
    db.prepare('INSERT INTO attendance_records(user, date, status, source, note) VALUES(?,?,?,?,?)')
      .run(String(b.user), String(b.date), 'manual', 'manual', String(b.note || ''));
    audit(db, me.name, 'attendance_manual', `${b.user}@${b.date}`, b.note);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/attendance' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者可查考勤（CMP-09 分域）');
    const rows = db.prepare('SELECT * FROM attendance_records ORDER BY date DESC, user LIMIT 500').all();
    return sendJson(res, 200, rows);
  }
  if (pathname === '/api/attendance/judge' && method === 'POST') { // 信标事件判定（网关上报/模拟）
    if (me.role === 'sales') throw new HttpError(403, '仅管理者可调用');
    const b = await readBody(req);
    const { periods, params } = judgeAttendance(b.events || [], b.params || {});
    let saved = [];
    if (b.save && b.user) {
      for (const d of periodsToDaily(periods)) {
        const r = db.prepare('INSERT INTO attendance_records(user, date, first_in, last_out, status, source) VALUES(?,?,?,?,?,?)')
          .run(String(b.user), d.date,
            d.firstIn ? new Date(d.firstIn).toISOString() : null,
            d.lastOut ? new Date(d.lastOut).toISOString() : null, 'auto', 'beacon');
        saved.push(Number(r.lastInsertRowid));
      }
      audit(db, me.name, 'attendance_judge', String(b.user), `${periods.length} 段`);
    }
    return sendJson(res, 200, { periods, daily: periodsToDaily(periods), saved, params });
  }

  throw new HttpError(404, 'API 不存在');
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- 服务器 ----------
// AI-11 定时报告：执行一个定时任务项（Ask AI 管理员视角检索 → 站内信投递）
async function fireScheduledItem(item, manual = false) {
  const d = JSON.parse(item.data || '{}');
  const { answer } = await answerQuestion('admin', 'scheduler', d.question || item.name);
  const recipients = (d.recipients && d.recipients.length) ? d.recipients : ['admin'];
  for (const user of recipients) {
    db.prepare('INSERT INTO notifications(user, title, body, created_at) VALUES(?,?,?,?)')
      .run(user, `[${item.name}] ${d.time || ''}`, answer + '\n\n（以上内容由 AI 生成，仅供参考）', new Date().toISOString());
  }
  db.prepare('UPDATE config_items SET data=? WHERE id=?').run(JSON.stringify({ ...d, last_fired: new Date().toISOString() }), item.id);
  audit(db, 'scheduler', 'scheduled_report', item.name, `→${recipients.join(',')}${manual ? '（手动触发）' : ''}`);
}

// AI-11 调度器：每分钟检查，到点且当日未发则补发（服务重启当日不错过）
function startScheduler() {
  setInterval(async () => {
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const currentMin = now.getHours() * 60 + now.getMinutes();
      for (const item of db.prepare("SELECT * FROM config_items WHERE domain='scheduled_reports' AND enabled=1").all()) {
        const d = JSON.parse(item.data || '{}');
        if (!d.time) continue;
        const [h, min] = String(d.time).split(':').map(Number);
        const firedToday = String(d.last_fired || '').slice(0, 10) === today;
        if (!firedToday && currentMin >= h * 60 + min) {
          try { await fireScheduledItem(item); } catch (e) { console.error(`[调度器] ${item.name} 失败:`, e.message); }
        }
      }
    } catch (e) { console.error('[调度器]', e.message); }
  }, 60_000).unref();
}

seed();
try { const purged = runRetentionPurge(db); console.log(`[留存] 启动清理：音频 ${purged.audio}，转写 ${purged.transcripts}，报告 ${purged.reports}（180天/3年，CMP-08）`); } catch (e) { console.error('[留存] 启动清理失败:', e.message); }
setInterval(() => { try { runRetentionPurge(db); } catch { /* 下轮再试 */ } }, 24 * 3600 * 1000).unref();
startScheduler();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code >= 500) console.error('[ERR]', req.method, url.pathname, e);
    sendJson(res, code, { error: e.message });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  BadgeCore 管理后台 v0.1（零依赖栈，D13）');
  console.log(`  http://localhost:${PORT}   （admin / admin123 首次登录后改密）`);
  console.log(`  库文件: ${DB_FILE}`);
  console.log(`  入库令牌: ${getSetting(db, 'ingest_token').slice(0, 8)}…（完整值见 设置页，receiver 用）`);
  console.log('==============================================');
});
