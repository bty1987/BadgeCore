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

const PORT = Number(process.env.PORT || 8200);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'badgecore.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_DOMAINS = [ // 04 册沟通配置九大域（ADM-01x）
  'info_fields', 'deal_models', 'task_models', 'ability_models',
  'summary_templates', 'analysis_dims', 'flows', 'violations', 'competitors',
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
    const info = db.prepare('INSERT INTO communications(created_at, duration_s, audio_path, transcript, status, owner, topic, meta) VALUES(?,?,?,?,?,?,?,?)')
      .run(
        b.created_at || new Date().toISOString(),
        Number(b.duration_s) || 0,
        String(b.audio_path || ''),
        String(b.transcript || ''),
        b.transcript ? 'transcribed' : 'recorded',
        String(b.owner || ''),
        String(b.topic || ''),
        JSON.stringify({ device: b.device || '', source: b.source || 'receiver' }),
      );
    const id = Number(info.lastInsertRowid);
    audit(db, 'receiver', 'ingest', `comm#${id}`, `${Number(b.duration_s) || 0}s`);
    const llm = getSetting(db, 'llm');
    if (llm.auto && b.transcript) {
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

  // 设置（LLM Key 只写不读，07 册 CMP-12 最小暴露）
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const llm = getSetting(db, 'llm');
      const token = getSetting(db, 'ingest_token');
      return sendJson(res, 200, {
        llm: { ...llm, api_key: undefined, has_api_key: !!llm.api_key },
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
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(403, '仅管理员可改设置');
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
seed();
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
