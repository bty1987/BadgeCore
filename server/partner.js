/**
 * 三方成品工牌推送接入（L3 二开接入的协议面，D24）
 * ------------------------------------------------------
 * 通用 Webhook 推送通道（平台 → 本服务）：POST /api/partner/push
 *   统一信封 {dataType, timeStamp, deviceNo, data}；dataType ∈
 *   AudioText(转写)/HeartbeatLog(心跳)/LoginLog/ControlLog/UploadLog/DebugLog(日志族)/Audio(录音文件 multipart)
 *   鉴权：v1 明文（须显式 allow_plain）/ v2 头部签名（默认推荐）
 *         Sign=md5(timestamp+requestId+appId+appSecret)，10 分钟时间戳窗口防重放
 *         / v3 签名+AES-CBC（base64 前 16 字节为 iv 前缀，key=appSecret 原文）
 * 映射：设备→devices（幂等 upsert，owner 只填空不覆盖真人绑定）；
 *   转写/录音→communications（三方文件名幂等去重，fileName 存 meta.partner.fileName）；
 *   日志→device_logs
 * 配置：settings 键 partner {app_id, app_secret, allow_plain}
 *   或 env PARTNER_APP_ID/PARTNER_APP_SECRET/PARTNER_ALLOW_PLAIN
 * 合规：转写入库前一律 redactText 脱敏（CMP-07）；录音落盘 data/recordings/partner 随留存策略清理
 * 边界：GPS 定位与合并录音下载、厂商主动查询 API 不在本通用层（涉及位置合规与厂商 API 形状，按具体厂商另行适配）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSetting, audit } = require('./db');
const { redactText } = require('./redact');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(__dirname, 'data', 'recordings', 'partner');
const PUSH_BODY_LIMIT = 64 * 1024 * 1024;   // 4G 设备单段录音可达十余 MB
const SIGN_FRESH_MS = 10 * 60 * 1000;       // v2 时间戳窗口（防重放）

function loadConfig(db) {
  const c = { ...(getSetting(db, 'partner') || {}) };
  if (!c.app_id && process.env.PARTNER_APP_ID) c.app_id = process.env.PARTNER_APP_ID;
  if (!c.app_secret && process.env.PARTNER_APP_SECRET) c.app_secret = process.env.PARTNER_APP_SECRET;
  if (c.allow_plain === undefined && process.env.PARTNER_ALLOW_PLAIN === 'true') c.allow_plain = true;
  c.enabled = Boolean(c.app_id && c.app_secret);
  return c;
}

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/** v2/v3 验签：Sign = md5(timestamp+requestId+appId+appSecret)，时间戳 10 分钟窗口防重放 */
function verifyPushSign(headers, appSecret) {
  const ts = String(headers['timestamp'] || '');
  const requestId = String(headers['request-id'] || '');
  const appId = String(headers['app-id'] || '');
  const sign = String(headers['sign'] || '').toLowerCase();
  if (!ts || !requestId || !appId || !sign) return '缺少签名头（App-Id/Request-Id/Timestamp/Sign）';
  const n = Number(ts);
  if (!Number.isFinite(n) || Math.abs(Date.now() - (n > 1e12 ? n : n * 1000)) > SIGN_FRESH_MS) {
    return '时间戳超出窗口（防重放）';
  }
  if (md5(ts + requestId + appId + appSecret) !== sign) return '签名不匹配';
  return null;
}

/** v3 解密：base64 前 16 字节为 iv 前缀，key=appSecret 原文（AES-128/192/256-CBC） */
function decryptV3(dataB64, appSecret) {
  const key = Buffer.from(appSecret, 'utf8');
  if (![16, 24, 32].includes(key.length)) throw new Error(`appSecret 长度 ${key.length} 字节，AES 需 16/24/32`);
  const full = Buffer.from(String(dataB64 || ''), 'base64');
  if (full.length <= 16) throw new Error('v3 密文过短');
  const decipher = crypto.createDecipheriv('aes-' + key.length * 8 + '-cbc', key, key.subarray(0, 16));
  return Buffer.concat([decipher.update(full.subarray(16)), decipher.final()]).toString('utf8');
}

/** multipart 解析：兼容 name/filename 带引号与不带引号两种写法 */
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}; const files = [];
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.slice(start, start + 2).toString() === '--') break; // 结束哨兵
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const next = body.indexOf(boundary, headEnd);
    if (next === -1) break;
    const head = body.slice(start, headEnd).toString('utf8');
    const content = body.slice(headEnd + 4, next - 2); // 去掉段尾 \r\n
    const nameM = /name=(?:"([^"]*)"|([^;\r\n]*))/i.exec(head);
    const fileM = /filename=(?:"([^"]*)"|([^;\r\n]*))/i.exec(head);
    const fieldName = nameM ? (nameM[1] !== undefined ? nameM[1] : nameM[2] || '').trim() : '';
    if (fileM) files.push({ name: fieldName, filename: (fileM[1] !== undefined ? fileM[1] : fileM[2] || '').trim(), data: content });
    else if (fieldName) fields[fieldName] = content.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeFileName(name) {
  const base = path.basename(String(name || ''));
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return cleaned || `audio-${Date.now()}.mp3`;
}

/** 设备幂等 upsert：owner 只填空不覆盖真人绑定（同步归属保护） */
function upsertDevice(db, key, patch = {}) {
  const now = new Date().toISOString();
  const dev = db.prepare('SELECT id FROM devices WHERE device_key=?').get(key);
  if (dev) {
    db.prepare('UPDATE devices SET status=COALESCE(?,status), last_seen_at=COALESCE(?,last_seen_at), fw_version=COALESCE(?,fw_version), battery=COALESCE(?,battery), model=COALESCE(?,model), owner=CASE WHEN ? != \'\' THEN ? ELSE owner END WHERE id=?')
      .run(patch.status ?? null, patch.last_seen ?? null, patch.fw ?? null, patch.battery ?? null, patch.model ?? null,
        patch.owner ?? '', patch.owner ?? '', dev.id);
    return dev.id;
  }
  return Number(db.prepare('INSERT INTO devices(device_key, model, fw_version, owner, battery, status, last_seen_at, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(key, patch.model || '', patch.fw || '', patch.owner || '', patch.battery || '', patch.status || 'unknown', patch.last_seen || now, now).lastInsertRowid);
}

/** 按三方文件名幂等落沟通记录：存在按 patch 补齐（转写回填/音频补挂），不存在插入 */
function upsertCommByFile(db, fileName, patch, insert) {
  const found = fileName ? db.prepare("SELECT id FROM communications WHERE json_extract(meta,'$.partner.fileName')=?").get(fileName) : null;
  if (found) {
    const sets = []; const params = [];
    if (patch.transcript !== undefined) { sets.push('transcript=?, status=?'); params.push(patch.transcript, 'transcribed'); }
    if (patch.audio_path) { sets.push("audio_path=CASE WHEN audio_path IS NULL OR audio_path='' THEN ? ELSE audio_path END"); params.push(patch.audio_path); }
    if (patch.duration_s) { sets.push('duration_s=?'); params.push(patch.duration_s); }
    if (sets.length) db.prepare(`UPDATE communications SET ${sets.join(', ')} WHERE id=?`).run(...params, found.id);
    return { id: found.id, created: false };
  }
  const id = Number(db.prepare(
    'INSERT INTO communications(created_at, duration_s, audio_path, transcript, status, owner, topic, customer_id, plan_id, meta, scene, participants) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(insert.created_at, insert.duration_s || 0, insert.audio_path || '', insert.transcript || '',
      insert.transcript ? 'transcribed' : 'recorded', insert.owner || '', insert.topic || '', null, null,
      JSON.stringify({ source: 'partner', partner: insert.partner }), insert.scene || 'sales', insert.participants || '').lastInsertRowid);
  return { id, created: true };
}

/** 转写文本拼装（说话人前缀 + 相对时间），入库前脱敏（CMP-07） */
function segmentsToText(segments) {
  return redactText((segments || [])
    .map(s => `[${s.startTimeStr || ''}]${s.speakerId != null ? ` 说话人${s.speakerId}` : ''}：${s.text || ''}`)
    .join('\n').trim());
}

function msToS(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 86400 ? Math.round(n / 1000) : Math.round(n); // 文档秒/毫秒标注混乱，>24h 按毫秒折算
}

function durationFromMs(d, segments) {
  const maxEnd = Math.max(0, ...(segments || []).map(s => Number(s.endMillisecond) || 0));
  if (maxEnd > 0) return Math.round(maxEnd / 1000);
  return msToS(d);
}

function deviceLog(db, deviceNo, action, detail) {
  db.prepare('INSERT INTO device_logs(device_key, ts, action, detail) VALUES(?,?,?,?)')
    .run(deviceNo, new Date().toISOString(), action, redactText(String(detail || '')).slice(0, 500));
}

// ---------- 推送处理 ----------
async function handlePush({ req, db, runAnalysis }) {
  // 统一返回 {status, body}，由调用方发送（readRawBody 期间异常已内含）
  const cfg = loadConfig(db);
  if (!cfg.enabled) return { status: 503, body: { error: '三方推送未配置（settings.partner 或 PARTNER_APP_ID/SECRET）' } };

  const version = String(req.headers['api-version'] || 'v1').toLowerCase();
  const signed = Boolean(req.headers['sign'] && req.headers['timestamp']);
  if (!signed && !cfg.allow_plain) {
    audit(db, 'partner', 'push_rejected', version, '明文推送未开启（allow_plain）');
    return { status: 403, body: { error: '明文推送未开启（allow_plain），请使用带签名模式' } };
  }
  if (signed) {
    const signErr = verifyPushSign(req.headers, cfg.app_secret);
    if (signErr) {
      audit(db, 'partner', 'push_rejected', version, signErr);
      return { status: 401, body: { error: `推送验签失败：${signErr}` } };
    }
  }

  const raw = await readRawBody(req, PUSH_BODY_LIMIT);
  const isMultipart = /multipart\/form-data/i.test(req.headers['content-type'] || '');
  let env = {}; let file = null;
  try {
    if (isMultipart) {
      const { fields, files } = parseMultipart(raw, req.headers['content-type']);
      let dataRaw = fields.data || fields.body || '{}';
      if (version === 'v3') dataRaw = decryptV3(dataRaw, cfg.app_secret); // v3：data/body 为 AES 密文
      env = JSON.parse(dataRaw);
      // 录音推送的信封字段在顶层表单（dataType/deviceNo/timeStamp），内层 data 只带文件信息
      env.dataType = fields.dataType || env.dataType;
      env.deviceNo = fields.deviceNo || env.deviceNo;
      env.timeStamp = fields.timeStamp || env.timeStamp;
      env.form = { ...fields };
      file = files.find(f => f.name === 'soundRecording') || files[0] || null;
    } else {
      const text = version === 'v3' ? decryptV3(raw.toString('utf8'), cfg.app_secret) : raw.toString('utf8');
      env = JSON.parse(text || '{}');
    }
  } catch (e) {
    audit(db, 'partner', 'push_rejected', `v${version}`, `载荷解析失败：${e.message}`);
    return { status: 400, body: { error: `载荷解析失败：${e.message}` } };
  }

  const type = String(env.dataType || '');
  // 设备号是 IMEI（15 位数字）不过 redactText——会被银行卡掩码规则改写
  const deviceNo = String(env.deviceNo || env.data?.deviceNo || '').trim();
  if (!deviceNo) return { status: 400, body: { error: '缺少 deviceNo' } };

  const now = new Date().toISOString();
  const dev = db.prepare('SELECT owner, default_scene FROM devices WHERE device_key=?').get(deviceNo);
  const scene = (dev && ['sales', 'meeting', 'training', 'talk'].includes(dev.default_scene)) ? dev.default_scene : 'sales';

  switch (type) {
    case 'AudioText': { // 转写推送：幂等落沟通（新建或回填），自动分析接线
      const d = env.data || {};
      const fileName = safeFileName(d.filename || d.fileName || '');
      const transcript = segmentsToText(d.segments);
      const duration = durationFromMs(d.duration, d.segments);
      if (!transcript) return sendJson(res, 400, { error: '转写内容为空' });
      const r = upsertCommByFile(db, fileName, { transcript, duration_s: duration }, {
        created_at: d.segments?.[0]?.dateStart || env.timeStamp || now,
        duration_s: duration, transcript,
        owner: (dev && dev.owner) || '', topic: '',
        partner: { fileName, deviceNo, taskId: d.taskId ?? null },
        scene,
      });
      upsertDevice(db, deviceNo, { status: 'online' });
      audit(db, 'partner', 'transcript_push', `comm#${r.id}`, `${fileName} ${transcript.length} 字 ${r.created ? '新建' : '回填'}`);
      let analyzed = false;
      const llm = getSetting(db, 'llm');
      if (llm.auto && transcript && r.created) {
        try { await runAnalysis(r.id, 'partner'); analyzed = true; } catch { /* 转写保留，分析状态已置 failed */ }
      }
      return { status: 200, body: { ok: true, id: r.id, created: r.created, analyzed } };
    }
    case 'HeartbeatLog': { // 心跳：设备 upsert + 台账字段刷新
      const d = env.data || {};
      upsertDevice(db, deviceNo, {
        status: 'online', last_seen: now,
        battery: d.battery != null ? String(d.battery) : null,
        fw: d.version || d.fw_version || null,
        model: d.deviceType || d.model || null,
      });
      deviceLog(db, deviceNo, 'heartbeat', `电量${d.battery ?? '?'} v${d.version || d.fw_version || '?'}`);
      return { status: 200, body: { ok: true } };
    }
    case 'Audio': { // 录音文件推送：落盘 + 幂等挂 audio_path
      if (!file || !file.data || !file.data.length) return { status: 400, body: { error: '缺少录音文件' } };
      const d = env.form || {};
      const fileName = safeFileName(file.filename || d.fileName || '');
      const dir = path.join(RECORDINGS_DIR, deviceNo);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, fileName);
      fs.writeFileSync(filePath, file.data);
      const duration = durationFromRange(d.startTime, d.endTime) || msToS(d.duration);
      const r = upsertCommByFile(db, fileName, { audio_path: filePath, duration_s: duration }, {
        created_at: parseChunkTime(d.startTime) || env.timeStamp || now,
        duration_s: duration,
        owner: (dev && dev.owner) || '', topic: '',
        partner: { fileName, deviceNo, chunkIndex: d.chunkIndex || '' },
        scene,
      });
      upsertDevice(db, deviceNo, { status: 'online' });
      audit(db, 'partner', 'audio_push', `comm#${r.id}`, `${fileName} ${file.data.length}B ${r.created ? '新建' : '补挂'}`);
      return { status: 200, body: { ok: true, id: r.id, created: r.created } };
    }
    case 'LoginLog':
    case 'ControlLog':
    case 'UploadLog':
    case 'DebugLog': { // 日志族：device_logs 台账
      deviceLog(db, deviceNo, type.replace(/Log$/, '').toLowerCase(), JSON.stringify(env.data || {}).slice(0, 400));
      upsertDevice(db, deviceNo, { status: 'online', last_seen: now });
      return { status: 200, body: { ok: true } };
    }
    default:
      return { status: 400, body: { error: `未知 dataType=${type || '(空)'}（支持：AudioText/HeartbeatLog/Audio/日志族）` } };
  }
}

/** YYMMDDHHmmss（如 260821091419）→ ISO；其余格式原样返回 */
function parseChunkTime(s) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return String(s || '');
  return `20${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
}
function durationFromRange(start, end) {
  const a = Date.parse(String(start || '')); const b = Date.parse(String(end || ''));
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? Math.round((b - a) / 1000) : 0;
}

module.exports = { loadConfig, handlePush, verifyPushSign, decryptV3, parseMultipart, upsertDevice };
