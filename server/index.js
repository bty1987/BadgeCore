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
  'knowledge_base', 'case_library', 'risk_rules', 'scheduled_reports', 'insight_categories',
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

// ---------- 全局配置（ADM-20x 内部版子集，D16）与数据范围 ----------
const GLOBAL_DEFAULTS = { view_scope: 'all', delete_min_role: 'manager', realtime_assist: true, analyze_first: true, silence_days: 14 };
function loadGlobals() {
  return { ...GLOBAL_DEFAULTS, ...(getSetting(db, 'globals') || {}) };
}

/** 部门子树内的用户名集合（manager 的部门数据范围，ADM-313） */
function deptSubtreeUsers(userName) {
  const u = db.prepare('SELECT dept_id FROM users WHERE name=?').get(userName);
  if (!u || !u.dept_id) return [userName];
  const kids = new Map();
  for (const d of db.prepare('SELECT id, parent_id FROM depts').all()) {
    kids.set(d.parent_id, [...(kids.get(d.parent_id) || []), d.id]);
  }
  const ids = [];
  const stack = [u.dept_id];
  while (stack.length) { const id = stack.pop(); ids.push(id); for (const k of kids.get(id) || []) stack.push(k); }
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT name FROM users WHERE dept_id IN (${ph})`).all(...ids).map(r => r.name).concat(userName);
}

/** 可见 owner 集合（null=全部；受全局配置 view_scope 与角色影响，ADM-202） */
function visibleOwners(me) {
  const g = loadGlobals();
  if (me.role === 'admin') return g.view_scope === 'self' ? [me.name] : null;
  if (me.role === 'manager') {
    if (g.view_scope === 'self') return [me.name];
    if (g.view_scope === 'dept') return deptSubtreeUsers(me.name);
    return null;
  }
  return [me.name]; // sales 恒为本人
}

/** 沉默客户预警（风险预警·沉默型，b2b 14 天默认）：按客户最近沟通时间扫描，站内信通知负责人 */
function checkSilence() {
  const g = loadGlobals();
  const days = Number(g.silence_days) || 0;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const c of db.prepare('SELECT id, name, owner, last_comm_at, silence_notified_at FROM customers WHERE last_comm_at IS NOT NULL AND last_comm_at < ?').all(cutoff)) {
    if (String(c.silence_notified_at || '').slice(0, 10) === today) continue; // 每客户每日最多提醒一次
    const msg = `客户「${c.name}」已 ${days} 天无沟通记录（最近：${String(c.last_comm_at).slice(0, 10)}），请安排跟进。（沉默风险预警）`;
    for (const user of c.owner ? [c.owner] : []) {
      db.prepare('INSERT INTO notifications(user, title, body, created_at) VALUES(?,?,?,?)').run(user, '沉默风险预警', msg, new Date().toISOString());
    }
    db.prepare('UPDATE customers SET silence_notified_at=? WHERE id=?').run(new Date().toISOString(), c.id);
    audit(db, 'scheduler', 'silence_alert', `customer#${c.id}`, `${days}天`);
    n++;
  }
  return n;
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
    const now = new Date().toISOString();
    const transcript = redactText(String(b.transcript || '')); // CMP-07：入库即脱敏（LLM/检索不接触明文）

    // 客户关联（REC-01：传 customer 名则查找或新建；先分析后关联 ADM-212 可入库后 PUT 补挂）
    let customerId = null;
    if (b.customer) {
      const cname = redactText(String(b.customer)).trim();
      const found = db.prepare('SELECT id FROM customers WHERE name=?').get(cname);
      if (found) customerId = found.id;
      else customerId = Number(db.prepare('INSERT INTO customers(name, owner, created_at, last_comm_at) VALUES(?,?,?,?)')
        .run(cname, String(b.owner || ''), now, now).lastInsertRowid);
    }

    // 设备台账（04 册设备管理域）：会话自动注册/上线 + 操作日志
    if (b.device) {
      const key = redactText(String(b.device));
      const dev = db.prepare('SELECT id FROM devices WHERE device_key=?').get(key);
      if (dev) db.prepare('UPDATE devices SET status=?, last_seen_at=? WHERE id=?').run('online', now, dev.id);
      else db.prepare('INSERT INTO devices(device_key, model, status, last_seen_at, created_at) VALUES(?,?,?,?,?)')
        .run(key, String(b.device_model || ''), 'online', now, now);
    }

    const info = db.prepare('INSERT INTO communications(created_at, duration_s, audio_path, transcript, status, owner, topic, customer_id, plan_id, meta) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(
        b.created_at || now,
        Number(b.duration_s) || 0,
        String(b.audio_path || ''),
        transcript,
        transcript ? 'transcribed' : 'recorded',
        String(b.owner || ''),
        String(b.topic || ''),
        customerId,
        b.plan_id ? Number(b.plan_id) : null,
        JSON.stringify({ device: b.device || '', source: b.source || 'receiver' }),
      );
    const id = Number(info.lastInsertRowid);
    audit(db, 'receiver', 'ingest', `comm#${id}`, `${Number(b.duration_s) || 0}s`);
    if (b.device) db.prepare('INSERT INTO device_logs(device_key, ts, action, detail) VALUES(?,?,?,?)')
      .run(redactText(String(b.device)), now, 'session', `comm#${id} ${Number(b.duration_s) || 0}s`);
    if (customerId) db.prepare('UPDATE customers SET last_comm_at=? WHERE id=?').run(b.created_at || now, customerId);
    // 实时辅助·规则预筛（AI-09，受全局配置 realtime_assist 开关控制）
    const alerts = loadGlobals().realtime_assist ? computeAlerts(transcript) : [];
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

  // 沟通记录（数据范围受全局配置 view_scope 影响，ADM-202/313）
  let m;
  const myScope = () => {
    const owners = visibleOwners(me);
    if (!owners) return { sql: '', params: [] };
    return { sql: `owner IN (${owners.map(() => '?').join(',')})`, params: owners };
  };
  if ((m = pathname.match(/^\/api\/communications$/)) && method === 'GET') {
    const { q = '', status = '' } = Object.fromEntries(url.searchParams);
    let sql = 'SELECT id, created_at, duration_s, status, owner, topic, customer_id, plan_id, report FROM communications';
    const where = []; const params = [];
    const scope = myScope();
    if (scope.sql) { where.push(scope.sql); params.push(...scope.params); }
    if (status) { where.push('status=?'); params.push(status); }
    if (q) { where.push('(topic LIKE ? OR transcript LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT 500';
    const rows = db.prepare(sql).all(...params).map(r => {
      const report = r.report ? JSON.parse(r.report) : null;
      const cust = r.customer_id ? db.prepare('SELECT name FROM customers WHERE id=?').get(r.customer_id) : null;
      return { ...r, report: undefined, customer: cust?.name || null, summary: report?.summary || '', intention: report?.intention || null };
    });
    return sendJson(res, 200, rows);
  }
  if ((m = pathname.match(/^\/api\/communications\/(\d+)$/))) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM communications WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '沟通记录不存在');
    const owners = visibleOwners(me);
    if (owners && !owners.includes(row.owner)) throw new HttpError(403, '无权访问该记录（数据范围）');
    if (method === 'GET') {
      row.report = row.report ? JSON.parse(row.report) : null;
      row.meta = JSON.parse(row.meta || '{}');
      const cust = row.customer_id ? db.prepare('SELECT id, name FROM customers WHERE id=?').get(row.customer_id) : null;
      row.customer = cust ? { id: cust.id, name: cust.name } : null;
      return sendJson(res, 200, row);
    }
    if (method === 'PUT' && me.role !== 'sales') { // 先分析后关联（ADM-212）：补挂客户/计划/主题
      const b = await readBody(req);
      let customerId = row.customer_id;
      if ('customer' in b) {
        if (!b.customer) customerId = null;
        else {
          const cname = redactText(String(b.customer)).trim();
          const found = db.prepare('SELECT id FROM customers WHERE name=?').get(cname);
          customerId = found ? found.id : Number(db.prepare('INSERT INTO customers(name, owner, created_at, last_comm_at) VALUES(?,?,?,?)')
            .run(cname, row.owner, new Date().toISOString(), row.created_at).lastInsertRowid);
        }
      }
      db.prepare('UPDATE communications SET customer_id=?, plan_id=?, topic=? WHERE id=?')
        .run(customerId, 'plan_id' in b ? (b.plan_id ? Number(b.plan_id) : null) : row.plan_id,
          'topic' in b ? String(b.topic) : row.topic, id);
      audit(db, me.name, 'comm_link', `comm#${id}`, b.customer || '');
      return sendJson(res, 200, { ok: true, customer_id: customerId });
    }
    if (method === 'DELETE') { // 删除权限独立配置（ADM-203：delete_min_role）
      const rank = { sales: 0, manager: 1, admin: 2 };
      const minRole = loadGlobals().delete_min_role || 'manager';
      if (rank[me.role] < rank[minRole]) throw new HttpError(403, `当前删除权限策略为「${minRole} 及以上」，无权删除`);
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
    const owners = visibleOwners(me);
    if (owners && !owners.includes(row.owner)) throw new HttpError(403, '无权导出该记录');
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
        globals: loadGlobals(),
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
      if (b.globals) { // 全局配置（ADM-20x 内部版子集，D16）
        const g = b.globals;
        setSetting(db, 'globals', {
          view_scope: ['all', 'dept', 'self'].includes(g.view_scope) ? g.view_scope : 'all',
          delete_min_role: ['manager', 'admin', 'all'].includes(g.delete_min_role) ? g.delete_min_role : 'manager',
          realtime_assist: g.realtime_assist !== false,
          analyze_first: g.analyze_first !== false,
          silence_days: Math.max(0, Number(g.silence_days) || 0),
        });
        audit(db, me.name, 'set_globals', JSON.stringify(g).slice(0, 120));
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
  if (pathname === '/api/silence-check' && method === 'POST' && me.role === 'admin') {
    return sendJson(res, 200, { notified: checkSilence() });
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
      return sendJson(res, 200, db.prepare(
        'SELECT u.id, u.name, u.role, u.active, u.created_at, u.dept_id, d.name AS dept_name FROM users u LEFT JOIN depts d ON u.dept_id=d.id ORDER BY u.id').all());
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
  // 用户更新（ADM-302/303：部门绑定/角色调整；复刻我的企业-员工名册）
  if ((m = pathname.match(/^\/api\/users\/(\d+)$/)) && me.role === 'admin' && method === 'PUT') {
    const id = Number(m[1]);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, '用户不存在');
    const b = await readBody(req);
    if (b.dept_id !== undefined) db.prepare('UPDATE users SET dept_id=? WHERE id=?').run(b.dept_id ? Number(b.dept_id) : null, id);
    if (b.role && ['admin', 'manager', 'sales'].includes(b.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
    audit(db, me.name, 'user_update', `user#${id}`, `dept=${b.dept_id ?? '-'} role=${b.role ?? '-'}`);
    return sendJson(res, 200, { ok: true });
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

  // 客户管理（04 册 §2：列表/详情/画像；销售仅本人名下）
  if (pathname === '/api/customers') {
    if (method === 'GET') {
      const { q = '' } = Object.fromEntries(url.searchParams);
      let sql = 'SELECT * FROM customers';
      const where = []; const params = [];
      if (me.role === 'sales') { where.push('owner=?'); params.push(me.name); }
      if (q) { where.push('(name LIKE ? OR note LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      const rows = db.prepare(sql + ' ORDER BY id DESC LIMIT 500').all(...params)
        .map(c => ({ ...c, profile: JSON.parse(c.profile || '{}') }));
      return sendJson(res, 200, rows);
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.name) throw new HttpError(400, '需要客户名');
      const r = db.prepare('INSERT INTO customers(name, phone, industry, profile, owner, note, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(redactText(String(b.name)), redactText(String(b.phone || '')), String(b.industry || ''),
          JSON.stringify(b.profile || {}), String(b.owner || (me.role === 'sales' ? me.name : '')), String(b.note || ''), new Date().toISOString());
      audit(db, me.name, 'customer_create', `customer#${r.lastInsertRowid}`, b.name);
      return sendJson(res, 200, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((m = pathname.match(/^\/api\/customers\/(\d+)$/))) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM customers WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '客户不存在');
    if (me.role === 'sales' && row.owner !== me.name) throw new HttpError(403, '仅本人名下客户');
    if (method === 'GET') { // 客户详情 + 历史沟通（ANA-11 上次沟通回顾的数据底座）
      row.profile = JSON.parse(row.profile || '{}');
      const owners = visibleOwners(me);
      const comms = db.prepare(`SELECT id, created_at, duration_s, status, topic, report FROM communications WHERE customer_id=? ${owners ? `AND owner IN (${owners.map(() => '?').join(',')})` : ''} ORDER BY id DESC LIMIT 20`)
        .all(id, ...(owners || [])).map(r => {
          const rp = r.report ? JSON.parse(r.report) : null;
          return { ...r, report: undefined, summary: rp?.summary || '' };
        });
      return sendJson(res, 200, { ...row, comms });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      db.prepare('UPDATE customers SET name=?, phone=?, industry=?, profile=?, owner=?, note=? WHERE id=?')
        .run(redactText(String(b.name ?? row.name)), redactText(String(b.phone ?? row.phone)), String(b.industry ?? row.industry),
          JSON.stringify(b.profile ?? JSON.parse(row.profile || '{}')), String(b.owner ?? row.owner), String(b.note ?? row.note), id);
      audit(db, me.name, 'customer_update', `customer#${id}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      if (me.role === 'sales') throw new HttpError(403, '销售不可删客户');
      db.prepare('DELETE FROM customers WHERE id=?').run(id);
      audit(db, me.name, 'customer_delete', `customer#${id}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  // 沟通计划（REC-02 安排沟通）
  if (pathname === '/api/plans') {
    if (method === 'GET') {
      let sql = 'SELECT p.*, c.name AS customer_name FROM plans p LEFT JOIN customers c ON p.customer_id=c.id';
      const where = []; const params = [];
      if (me.role === 'sales') { where.push('p.owner=?'); params.push(me.name); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      return sendJson(res, 200, db.prepare(sql + ' ORDER BY plan_at DESC LIMIT 200').all(...params));
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.title) throw new HttpError(400, '需要标题');
      const r = db.prepare('INSERT INTO plans(title, customer_id, owner, plan_at, flow, info_fields, created_at) VALUES(?,?,?,?,?,?,?)')
        .run(String(b.title), b.customer_id ? Number(b.customer_id) : null,
          String(b.owner || (me.role === 'sales' ? me.name : '')), b.plan_at || '', String(b.flow || ''),
          JSON.stringify(b.info_fields || {}), new Date().toISOString());
      audit(db, me.name, 'plan_create', `plan#${r.lastInsertRowid}`, b.title);
      return sendJson(res, 200, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((m = pathname.match(/^\/api\/plans\/(\d+)(\/complete)?$/))) {
    const id = Number(m[1]);
    if (m[2] && method === 'POST') { // 标记完成（沟通结束后）
      db.prepare('UPDATE plans SET status=? WHERE id=?').run('done', id);
      audit(db, me.name, 'plan_done', `plan#${id}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM plans WHERE id=?').run(id);
      audit(db, me.name, 'plan_delete', `plan#${id}`);
      return sendJson(res, 200, { ok: true });
    }
  }

  // 设备管理（04 册：台账/绑定/操作日志；固件升级缓期 D16——receiver OTA 即开发期通道）
  if (pathname === '/api/devices' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者可看台账');
    return sendJson(res, 200, db.prepare('SELECT * FROM devices ORDER BY id DESC LIMIT 500').all());
  }
  if ((m = pathname.match(/^\/api\/devices\/(\d+)\/bind$/)) && method === 'POST') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者可绑定');
    const b = await readBody(req);
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(Number(m[1]));
    if (!dev) throw new HttpError(404, '设备不存在');
    db.prepare('UPDATE devices SET owner=?, model=? WHERE id=?').run(String(b.owner || ''), String(b.model ?? dev.model), dev.id);
    db.prepare('INSERT INTO device_logs(device_key, ts, action, detail) VALUES(?,?,?,?)')
      .run(dev.device_key, new Date().toISOString(), b.owner ? 'bind' : 'unbind', `${dev.owner || '-'} → ${b.owner || '(解绑)'}`);
    audit(db, me.name, b.owner ? 'device_bind' : 'device_unbind', dev.device_key, String(b.owner || ''));
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/devices/logs' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    return sendJson(res, 200, db.prepare('SELECT * FROM device_logs ORDER BY id DESC LIMIT 300').all());
  }

  // 组织架构（ADM-301 部门树；角色权限自定义树缓期 D16——内部三角色够用）
  if (pathname === '/api/depts') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    if (method === 'GET') {
      const rows = db.prepare('SELECT * FROM depts ORDER BY id').all();
      const counts = db.prepare('SELECT dept_id, COUNT(*) c FROM users WHERE dept_id IS NOT NULL GROUP BY dept_id').all();
      const cmap = new Map(counts.map(r => [r.dept_id, r.c]));
      return sendJson(res, 200, rows.map(d => ({ ...d, member_count: cmap.get(d.id) || 0 })));
    }
    if (method === 'POST') {
      const b = await readBody(req);
      if (!b.name) throw new HttpError(400, '需要部门名');
      const r = db.prepare('INSERT INTO depts(name, parent_id, leader) VALUES(?,?,?)')
        .run(String(b.name), b.parent_id ? Number(b.parent_id) : null, String(b.leader || ''));
      audit(db, me.name, 'dept_create', `dept#${r.lastInsertRowid}`, b.name);
      return sendJson(res, 200, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((m = pathname.match(/^\/api\/depts\/(\d+)$/))) {
    if (me.role !== 'admin') throw new HttpError(403, '仅管理员');
    if (method === 'PUT') {
      const b = await readBody(req);
      db.prepare('UPDATE depts SET name=?, parent_id=?, leader=? WHERE id=?')
        .run(String(b.name), b.parent_id ? Number(b.parent_id) : null, String(b.leader || ''), Number(m[1]));
      audit(db, me.name, 'dept_update', `dept#${m[1]}`);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      db.prepare('UPDATE users SET dept_id=NULL WHERE dept_id=?').run(Number(m[1]));
      db.prepare('UPDATE depts SET parent_id=NULL WHERE parent_id=?').run(Number(m[1]));
      db.prepare('DELETE FROM depts WHERE id=?').run(Number(m[1]));
      audit(db, me.name, 'dept_delete', `dept#${m[1]}`);
      return sendJson(res, 200, { ok: true });
    }
  }
  if ((m = pathname.match(/^\/api\/users\/(\d+)\/dept$/)) && method === 'POST' && me.role === 'admin') {
    const b = await readBody(req);
    db.prepare('UPDATE users SET dept_id=? WHERE id=?').run(b.dept_id ? Number(b.dept_id) : null, Number(m[1]));
    audit(db, me.name, 'user_dept', `user#${m[1]}`, String(b.dept_id || ''));
    return sendJson(res, 200, { ok: true });
  }

  // 数据看板（对标 ops_dashboard，D17；manager 及以上）
  if (pathname === '/api/dashboard' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者可看看板');
    const days = Math.min(365, Math.max(1, Number(Object.fromEntries(url.searchParams).days) || 30));
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return sendJson(res, 200, { days, ...dashboardStats(since, null) });
  }
  if (pathname === '/api/dashboard/export' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    const days = Math.min(365, Math.max(1, Number(Object.fromEntries(url.searchParams).days) || 30));
    const stats = dashboardStats(new Date(Date.now() - days * 86400_000).toISOString(), null);
    const text = [
      'BadgeCore 数据看板导出',
      `【水印】导出人: ${me.name}（${me.role}）  时间: ${new Date().toLocaleString('zh-CN')}  本次导出已记入审计日志`,
      '='.repeat(50),
      `近 ${days} 天概览: ${JSON.stringify(stats.overview, null, 2)}`,
      `每日明细: ${stats.by_day.map(d => `${d.date} ${d.count}次/${Math.round(d.duration / 60)}分钟`).join('\n  ')}`,
      `任务达成榜: ${stats.rank_tasks.map((u, i) => `${i + 1}. ${u.owner} ${u.task_rate}%`).join('、') || '无'}`,
      `能力榜: ${stats.rank_ability.map((u, i) => `${i + 1}. ${u.owner} ${u.intention}`).join('、') || '无'}`,
    ].join('\n');
    audit(db, me.name, 'export', 'dashboard', `days=${days} 水印导出`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="badgecore-dashboard.txt"' });
    return res.end(text);
  }

  // 团队报告（对标 team_report 周报/月报，D17）
  if (pathname === '/api/report/generate' && method === 'POST') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    const b = await readBody(req);
    const report = await generateTeamReport(['weekly', 'monthly'].includes(b.period) ? b.period : 'weekly', b.ref, me.role, me.name);
    return sendJson(res, 200, report);
  }
  if (pathname === '/api/report/list' && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    const rows = db.prepare('SELECT id, period, start_at, end_at, content, created_at FROM team_reports ORDER BY id DESC LIMIT 50').all()
      .map(r => { const c = JSON.parse(r.content); return { ...r, content: undefined, label: c.label, summary: c.summary, ai_generated: !!c.ai_generated }; });
    return sendJson(res, 200, rows);
  }
  if ((m = pathname.match(/^\/api\/report\/(\d+)$/)) && method === 'GET') {
    if (me.role === 'sales') throw new HttpError(403, '仅管理者');
    const row = db.prepare('SELECT * FROM team_reports WHERE id=?').get(Number(m[1]));
    if (!row) throw new HttpError(404, '报告不存在');
    row.content = JSON.parse(row.content);
    return sendJson(res, 200, row);
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

// ---------- 看板统计（对标 ops_dashboard/team_report，D17） ----------
/** 聚合一段时间内的沟通数据（含报告解析） */
function dashboardStats(sinceIso, owners) {
  const ownerFilter = owners ? `AND owner IN (${owners.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT id, created_at, duration_s, owner, topic, status, report, meta FROM communications WHERE created_at >= ? ${ownerFilter}`)
    .all(sinceIso, ...(owners || []));
  const byOwner = new Map();
  const byDay = new Map();
  let totalDur = 0, violComms = 0, intentionSum = 0, intentionN = 0;
  for (const r of rows) {
    const day = String(r.created_at).slice(0, 10);
    const d = byDay.get(day) || { date: day, count: 0, duration: 0 };
    d.count++; d.duration += r.duration_s || 0; byDay.set(day, d);
    totalDur += r.duration_s || 0;
    const rp = r.report ? JSON.parse(r.report) : null;
    const meta = r.meta ? JSON.parse(r.meta) : {};
    const o = byOwner.get(r.owner || '（未指定）') || { owner: r.owner || '（未指定）', count: 0, duration: 0, taskDone: 0, taskTotal: 0, intentionSum: 0, intentionN: 0, violations: 0 };
    o.count++; o.duration += r.duration_s || 0;
    if (rp?.tasks?.length) { o.taskTotal += rp.tasks.length; o.taskDone += rp.tasks.filter(t => t.status === '完成').length; }
    if (rp?.intention?.score != null) { o.intentionSum += rp.intention.score; o.intentionN++; intentionSum += rp.intention.score; intentionN++; }
    if ((meta.alerts || []).length || rp?.violations?.length) { violComms++; o.violations++; }
    byOwner.set(o.owner, o);
  }
  const users = [...byOwner.values()].map(o => ({
    ...o,
    intention: o.intentionN ? Math.round(o.intentionSum / o.intentionN) : null,
    task_rate: o.taskTotal ? Math.round(o.taskDone / o.taskTotal * 100) : null,
  }));
  return {
    overview: {
      comm_count: rows.length,
      total_duration: Math.round(totalDur),
      user_count: byOwner.size,
      violation_rate: rows.length ? Math.round(violComms / rows.length * 100) : 0,
      avg_intention: intentionN ? Math.round(intentionSum / intentionN) : null,
    },
    by_day: [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : 1),
    rank_tasks: [...users].filter(u => u.task_rate !== null).sort((a, b) => b.task_rate - a.task_rate),
    rank_ability: [...users].filter(u => u.intention !== null).sort((a, b) => b.intention - a.intention),
    violation_dist: users.filter(u => u.violations > 0).map(u => ({
      owner: u.owner, violations: u.violations, rate: u.count ? Math.round(u.violations / u.count * 100) : 0, count: u.count,
    })),
    recent: rows.slice(-10).reverse().map(r => ({
      id: r.id, created_at: r.created_at, owner: r.owner, topic: r.topic, status: r.status,
      alerts: (JSON.parse(r.meta || '{}').alerts || []).length,
    })),
  };
}

/** 团队报告（mock/LLM 生成总结） */
async function generateTeamReport(period, refDate, role, name) {
  const ref = refDate ? new Date(refDate) : new Date();
  let start, end, label;
  if (period === 'monthly') {
    start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
    label = `${ref.getFullYear()} 年 ${ref.getMonth() + 1} 月月报`;
  } else {
    const dow = (ref.getDay() + 6) % 7; // 周一为一周开始
    start = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - dow);
    end = new Date(start.getTime() + 7 * 86400_000);
    label = `${start.toISOString().slice(0, 10)} 周报`;
  }
  const stats = dashboardStats(start.toISOString(), null);
  const llm = getSetting(db, 'llm');
  let ai;
  if (!llm || llm.provider === 'mock') {
    const top = stats.rank_ability[0], violTop = stats.violation_dist[0];
    ai = {
      summary: `【Mock】本${period === 'monthly' ? '月' : '周'}共沟通 ${stats.overview.comm_count} 次、合计 ${Math.round(stats.overview.total_duration / 60)} 分钟、${stats.overview.user_count} 人参与；平均意向度 ${stats.overview.avg_intention ?? '-'}，沟通违规率 ${stats.overview.violation_rate}%。`,
      highlights: [
        top ? `能力榜首：${top.owner}（平均意向度 ${top.intention}）` : '暂无足够数据',
        stats.rank_tasks[0] ? `任务达成最高：${stats.rank_tasks[0].owner}（${stats.rank_tasks[0].task_rate}%）` : '暂无任务数据',
      ],
      risks: [
        violTop ? `违规集中：${violTop.owner}（${violTop.violations} 次，命中率 ${violTop.rate}%）` : '未检出违规',
        stats.overview.comm_count === 0 ? '本周无沟通记录，需推动外勤拜访' : null,
      ].filter(Boolean),
      ai_generated: true,
    };
  } else {
    const raw = await fetch(llm.base_url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.api_key}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: '你是销售团队管理报告助手。依据统计数据输出严格 JSON：{summary:string, highlights:string[], risks:string[]}，结论只来自数据，中文。' },
          { role: 'user', content: `【${label} 统计】\n${JSON.stringify(stats.overview)}\n能力榜:${JSON.stringify(stats.rank_ability.slice(0, 5))}\n任务榜:${JSON.stringify(stats.rank_tasks.slice(0, 5))}\n违规分布:${JSON.stringify(stats.violation_dist)}` },
        ],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!raw.ok) throw new HttpError(502, `LLM HTTP ${raw.status}`);
    const d = await raw.json();
    ai = JSON.parse(String(d.choices?.[0]?.message?.content || '{}').replace(/```(?:json)?|```/g, '').trim());
    ai.ai_generated = true;
  }
  const r = db.prepare('INSERT INTO team_reports(period, start_at, end_at, content, created_at, created_by) VALUES(?,?,?,?,?,?)')
    .run(period, start.toISOString(), end.toISOString(), JSON.stringify({ label, stats, ...ai }), new Date().toISOString(), name);
  audit(db, name, 'report_generate', `#${r.lastInsertRowid}`, label);
  return { id: Number(r.lastInsertRowid), label, stats, ...ai };
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
// 入库令牌落盘（server/data/ 已 gitignore），供 start.bat 自动注入 receiver
try { fs.writeFileSync(path.join(__dirname, 'data', 'ingest-token.txt'), getSetting(db, 'ingest_token')); } catch { /* 首次写失败不影响启动 */ }
try { const purged = runRetentionPurge(db); console.log(`[留存] 启动清理：音频 ${purged.audio}，转写 ${purged.transcripts}，报告 ${purged.reports}（180天/3年，CMP-08）`); } catch (e) { console.error('[留存] 启动清理失败:', e.message); }
setInterval(() => { try { runRetentionPurge(db); } catch { /* 下轮再试 */ } }, 24 * 3600 * 1000).unref();
setInterval(() => { try { checkSilence(); } catch (e) { console.error('[沉默预警]', e.message); } }, 3600 * 1000).unref(); // 风险预警·沉默型（D16）
try { checkSilence(); } catch { /* 启动时静默尝试 */ }
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
