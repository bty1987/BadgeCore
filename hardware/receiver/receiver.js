/**
 * BadgeCore 第一公里：最小接收服务端
 * ------------------------------------
 * 1. HTTP GET /xiaozhi/ota/  → 告诉设备 WebSocket 地址（OTA 协议，见 78/xiaozhi-esp32 main/ota.cc）
 * 2. WS   /xiaozhi/v1/       → 完成 hello 握手后，接收 OPUS 音频帧，会话结束封装 Ogg 落盘
 *
 * 协议实测要点（详见 ../HARDWARE-LOG.md 第六节）：
 * - 设备 hello: {"type":"hello","version":2,"transport":"websocket","audio_params":{...}}
 * - 服务端 hello 响应需含 transport:"websocket" + session_id + audio_params
 * - version=2 二进制帧头 16 字节：version(u16BE) type(u8) reserved(u8) timestamp(u64BE) payload_size(u32BE)
 * - 设备待机不连 WS，触发对话才建立音频通道
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { buildOggOpus } = require('./ogg-writer');
const { loadConfig: loadXfConfig } = require('./xfyun-iat');
const { createLiveTranscriber } = require('./asr-live');

const PORT = 8100; // 8000 被本机 aTrust VPN 组件占用，避开
const SESSIONS_DIR = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ---------- 会话模式（docs/会话模式设计，09 册 INT-02）----------
// explicit（默认）: 一次 VAD 会话=一条沟通记录（销售场景，行为与 v0.3 完全一致）
// continuous      : VAD 会话文本/音频帧追加「工作会话缓冲」，按 每日定时 + 手动 收口聚合入库（会议/前台等长场景）
const SESSION_MODE = process.env.SESSION_MODE === 'continuous' ? 'continuous' : 'explicit';
const GAP_CLOSE_MINUTES = Number(process.env.GAP_CLOSE_MINUTES || 10);       // 软分段：静音超此时长在缓冲内插分段标记
const DAILY_CLOSE_TIME = String(process.env.DAILY_CLOSE_TIME || '18:00');    // 每日自动收口时刻（HH:MM）
const SPOOL_FILE = path.join(SESSIONS_DIR, 'work-buffer-spool.json');         // 缓冲落盘（重启恢复文本；音频帧不落盘，重启后收口无音频仅文本）

// 讯飞听写凭据（缺省则仅录制不转写；配置方法见 asr.config.example.json）
const XF_CONFIG = loadXfConfig(true);

// 工作会话缓冲（continuous 模式，按设备聚合）
const workBuffers = new Map(); // deviceKey → { device, texts:[], frames:[], frameMs, startedAt, lastActivityAt, segCount, frameCount }
function getBuffer(deviceKey) {
  if (!workBuffers.has(deviceKey)) {
    workBuffers.set(deviceKey, { device: deviceKey, texts: [], frames: [], frameMs: 60, startedAt: null, lastActivityAt: null, segCount: 0, frameCount: 0 });
  }
  return workBuffers.get(deviceKey);
}
function saveSpool() {
  try {
    const data = [...workBuffers.values()].filter(b => b.texts.length).map(b => ({
      device: b.device, texts: b.texts, startedAt: b.startedAt, lastActivityAt: b.lastActivityAt, segCount: b.segCount,
    }));
    if (data.length) fs.writeFileSync(SPOOL_FILE, JSON.stringify(data));
    else if (fs.existsSync(SPOOL_FILE)) fs.unlinkSync(SPOOL_FILE);
  } catch (e) { console.warn('[BUF] 缓冲落盘失败:', e.message); }
}
function loadSpool() {
  try {
    if (!fs.existsSync(SPOOL_FILE)) return;
    for (const d of JSON.parse(fs.readFileSync(SPOOL_FILE, 'utf8'))) {
      const b = getBuffer(d.device);
      Object.assign(b, d); // 音频帧不恢复：重启后收口仅聚合文本（防丢优先）
      console.log(`[BUF] 恢复工作缓冲 ${d.device}（${d.texts.length} 段文本，音频帧需重录）`);
    }
  } catch (e) { console.warn('[BUF] 缓冲恢复失败:', e.message); }
}
loadSpool();

/** 收口一个设备缓冲：拼接文本 + 合并 Ogg → 一次入库（09 册 INT-02/K6） */
function closeBuffer(deviceKey, reason) {
  const b = workBuffers.get(deviceKey);
  if (!b || (!b.texts.length && !b.frameCount)) { workBuffers.delete(deviceKey); return null; }
  const text = b.texts.join('\n');
  let audioPath = '';
  if (b.frameCount > 0) {
    // 合并音频：把缓冲内所有 OPUS 帧按序封装为一个 Ogg（buildOggOpus 本就按帧序编 granule，天然支持拼接）
    const merged = path.join(SESSIONS_DIR, `workbuf-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 6)}.ogg`);
    fs.writeFileSync(merged, buildOggOpus(b.frames, b.frameMs));
    audioPath = merged;
  }
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const startT = b.startedAt ? `${pad(new Date(b.startedAt).getHours())}:${pad(new Date(b.startedAt).getMinutes())}` : '--:--';
  const topic = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} 聚合记录（${startT}-${pad(d.getHours())}:${pad(d.getMinutes())}，${b.segCount} 段，${reason}收口）`;
  const payload = JSON.stringify({
    created_at: new Date().toISOString(),
    duration_s: b.frameCount * b.frameMs / 1000,
    audio_path: audioPath,
    transcript: text,
    device: b.device,
    device_model: 'ai-passport',
    owner: '',
    topic,
  });
  const base = process.env.BADGE_SERVER;
  if (base) {
    fetch(base.replace(/\/$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': process.env.BADGE_TOKEN || '' },
      body: payload,
      signal: AbortSignal.timeout(8000),
    }).then(r => r.json()).then(res => {
      if (res.id) {
        console.log(`[BUF] ${deviceKey} ${reason}收口入库 comm#${res.id}${res.analyzed ? '（已分析）' : ''}（${b.segCount} 段 → 1 条聚合记录）`);
        if (audioPath && XF_CONFIG && process.env.BADGE_LFASR !== 'off') runSpeakerDiarization(res.id, audioPath);
      } else console.log(`[BUF] 收口入库被拒: ${res.error || JSON.stringify(res)}`);
    }).catch(e => console.log(`[BUF] 收口入库失败: ${e.message}`));
  } else {
    console.log(`[BUF] ${deviceKey} ${reason}收口（未配 BADGE_SERVER，仅落盘 ${audioPath || '无音频'}）`);
  }
  workBuffers.delete(deviceKey);
  saveSpool();
  return { segCount: b.segCount, textLen: text.length, audioPath };
}

// 每日定时收口（continuous）：到 DAILY_CLOSE_TIME 且当日未收口
let lastDailyClose = new Date().toISOString().slice(0, 10);
setInterval(() => {
  if (SESSION_MODE !== 'continuous' || !workBuffers.size) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const [h, m] = DAILY_CLOSE_TIME.split(':').map(Number);
  if (today === lastDailyClose || (now.getHours() * 60 + now.getMinutes()) < h * 60 + m) return;
  lastDailyClose = today;
  for (const key of [...workBuffers.keys()]) closeBuffer(key, '定时');
}, 60_000).unref();

// 实时辅助关键词（AI-09 一期规则层）：环境变量 XF_ALERT_KEYWORDS，逗号分隔，与后台竞品库/风险规则保持一致
const ALERT_WORDS = (process.env.XF_ALERT_KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean);

const stats = { sessions: 0, totalFrames: 0, totalBytes: 0, activeWs: 0 };

// 工牌身份显示（BadgeCore 定制，需配套固件含 identity 解析；改内容免重刷固件）
// 优先级：badge-identity.json（照 badge-identity.example.json 填）> 环境变量 BADGE_IDENTITY(JSON)
// 文件变化实时广播给在线设备（type:"identity" WS 消息）；离线设备靠 5 分钟空闲 OTA 重检或下次连接拿到
function loadBadgeIdentity() {
  try {
    const p = path.join(__dirname, 'badge-identity.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[OTA] badge-identity.json 读取失败:', e.message);
  }
  if (process.env.BADGE_IDENTITY) {
    try { return JSON.parse(process.env.BADGE_IDENTITY); } catch {}
  }
  return null;
}
let BADGE_IDENTITY = loadBadgeIdentity();

// 广播身份给所有在线设备（hello 后也推一次）
function broadcastIdentity() {
  if (!BADGE_IDENTITY) return;
  const msg = JSON.stringify({ type: 'identity', ...BADGE_IDENTITY });
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) { ws.send(msg); n++; }
  }
  if (n) console.log(`[OTA] 身份已推送 ${n} 台在线设备: ${JSON.stringify(BADGE_IDENTITY).slice(0, 80)}`);
}

// ---------- 固件自分发（OTA）：hardware/receiver/firmware/ 下放 xiaozhi-<版本>.bin ----------
const FIRMWARE_DIR = path.join(__dirname, 'firmware');
fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
function latestFirmware() {
  try {
    const bins = fs.readdirSync(FIRMWARE_DIR).filter(f => f.endsWith('.bin')).map(f => {
      const m = f.match(/(\d+\.\d+\.\d+)/);
      return m ? { file: f, version: m[1], parts: m[1].split('.').map(Number) } : null;
    }).filter(Boolean);
    if (!bins.length) return null;
    bins.sort((a, b) => a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2]);
    return bins[bins.length - 1];
  } catch { return null; }
}

// ---------- HTTP：OTA 接口 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/xiaozhi/ota/' || url.pathname === '/xiaozhi/ota') {
    const host = req.headers.host || '';
    const wsHost = host.includes(':') ? host.split(':')[0] : host; // 设备与电脑同局域网，用同一 IP
    const fw = latestFirmware();
    const body = {
      websocket: {
        url: `ws://${wsHost}:${PORT}/xiaozhi/v1/`,
        token: 'badgecore-dev',
        version: 2,
      },
      // 有固件包则下发（设备自行比版本决定是否升级，空闲时 5 分钟一检）
      firmware: fw ? { version: fw.version, url: `http://${wsHost}:${PORT}/firmware/${encodeURIComponent(fw.file)}` }
                   : { version: '2.4.2', url: '' },
      server_time: { timestamp: Date.now(), timezone_offset: 480 },
    };
    if (BADGE_IDENTITY) {
      body.identity = BADGE_IDENTITY; // 设备空闲时屏幕显示此身份内容
    }
    console.log(`[OTA] ${new Date().toLocaleTimeString()} Device-Id=${req.headers['device-id'] || '?'} Client-Id=${req.headers['client-id'] || '?'} UA=${req.headers['user-agent'] || '?'} → 下发 ws://${wsHost}:${PORT}${fw ? ` 固件${fw.version}` : ''}`);
    // 设备心跳：OTA 检查即心跳（版本在 UA，电量/运行时长在自定义头），转发到后台设备台账
    if (process.env.BADGE_SERVER && process.env.BADGE_TOKEN && req.headers['device-id']) {
      const ua = req.headers['user-agent'] || '';
      const vm = ua.match(/(\d+\.\d+\.\d+)/);
      const payload = JSON.stringify({
        device: `xiaozhi-passport:${req.headers['device-id'] || 'unknown'}`,
        model: 'ai-passport',
        version: vm ? vm[1] : '',
        battery: req.headers['x-battery'] ? `${req.headers['x-battery']}%${req.headers['x-charging'] === '1' ? ' 充电中' : ''}` : '',
        ip: req.socket.remoteAddress || '',
        uptime_s: Number(req.headers['x-uptime'] || 0),
        heap_free: Number(req.headers['x-heap-free'] || 0),
      });
      try {
        const hb = http.request(process.env.BADGE_SERVER + '/api/device-heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': process.env.BADGE_TOKEN, 'Content-Length': Buffer.byteLength(payload) },
        });
        hb.on('error', () => {});
        hb.end(payload);
      } catch { /* 心跳失败不影响 OTA 响应 */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  if (url.pathname.startsWith('/firmware/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice('/firmware/'.length)));
    const file = path.join(FIRMWARE_DIR, name);
    if (!name.endsWith('.bin') || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const stat = fs.statSync(file);
    console.log(`[OTA] 固件下载开始: ${name} (${(stat.size / 1024).toFixed(0)}KB)`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    res.on('close', () => {
      const sent = stream.bytesRead;
      console.log(`[OTA] 固件下载${sent >= stat.size ? '完成' : '中断'}: ${name} 已传 ${(sent / 1024).toFixed(0)}KB / ${(stat.size / 1024).toFixed(0)}KB`);
    });
    return;
  }
  // 手动收口（09 册 INT-02：continuous 模式下立即聚合缓冲入库；后台「会话收口」按钮经 /api/session/close 代理到这里）
  if (url.pathname === '/session/close' && (req.method === 'POST' || req.method === 'GET')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let device = '';
      try { device = JSON.parse(body || '{}').device || ''; } catch { /* 忽略 body */ }
      const keys = device ? [...workBuffers.keys()].filter(k => k === device || k.includes(device)) : [...workBuffers.keys()];
      const closed = keys.map(k => closeBuffer(k, '手动')).filter(Boolean).length;
      const r = { ok: true, mode: SESSION_MODE, closed, buffers: workBuffers.size };
      console.log(`[BUF] 手动收口: ${r.closed} 个缓冲入库（现存 ${r.buffers} 个）`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// badge-identity.json 变化 → 重载并实时推送给在线设备
// （watch 目录而非文件：编辑器"临时文件+改名"保存不会跟丢）
try {
  fs.watch(__dirname, (event, filename) => {
    if (filename === 'badge-identity.json') {
      BADGE_IDENTITY = loadBadgeIdentity();
      broadcastIdentity();
    }
  });
} catch (e) { /* 目录不可 watch 时忽略 */ }

// ---------- WebSocket：音频流接收 ----------
const wss = new WebSocketServer({ server, path: '/xiaozhi/v1/' });

wss.on('connection', (ws, req) => {
  stats.activeWs++;
  stats.sessions++;
  const deviceId = req.headers['device-id'] || ''; // 真实设备标识（心跳/入库共用同一 key 格式）
  const sessionId = crypto.randomUUID().slice(0, 8);
  const filePath = path.join(SESSIONS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionId}.ogg`);
  let protocolVersion = 2;
  let frameCount = 0;
  let byteCount = 0;
  let frameList = []; // 缓存原始 Opus packet，会话结束封装 Ogg
  let frameMs = 60;
  let transcriber = null; // 实时转写器（首帧音频时懒创建）
  let oggPath = null; // 落盘后的录音文件路径（入库用）
  const firedAlerts = new Set(); // 实时辅助已触发关键词（每连接去重）

  console.log(`\n[WS ] 设备接入 #${stats.sessions} from ${req.socket.remoteAddress} → 会话 ${sessionId}`);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg = {};
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'hello') {
        protocolVersion = msg.version || 2;
        if (msg.audio_params && msg.audio_params.frame_duration) frameMs = msg.audio_params.frame_duration;
        console.log(`[WS ] 设备 hello: version=${protocolVersion} transport=${msg.transport} audio=${JSON.stringify(msg.audio_params || {})}`);
        ws.send(JSON.stringify({
          type: 'hello',
          transport: 'websocket',
          session_id: crypto.randomUUID(),
          audio_params: { sample_rate: 16000, frame_duration: 60 },
        }));
        console.log(`[WS ] 已回 server hello，等待音频帧… (会话 ${sessionId})`);
        if (BADGE_IDENTITY) {
          ws.send(JSON.stringify({ type: 'identity', ...BADGE_IDENTITY })); // 连接即同步最新身份
        }
      } else {
        console.log(`[WS ] 文本消息: ${data.toString().slice(0, 120)}`);
      }
      return;
    }
    // 二进制音频帧
    let payload = data;
    // v2 帧头实测 16 字节：version(2BE) type(1) reserved(1) timestamp(u64BE,4-11) payload_size(u32BE,12-15)
    if (protocolVersion === 2 && data.length >= 16) {
      const payloadSize = data.readUInt32BE(12);
      if (frameCount === 0) console.log(`[DBG] v2解析: payloadSize=${payloadSize} timestamp=${data.readBigUInt64BE(4)}`);
      payload = data.subarray(16, 16 + payloadSize);
    } else if (protocolVersion === 3 && data.length >= 4) {
      const payloadSize = data.readUInt16BE(2);
      payload = data.subarray(4, 4 + payloadSize);
    }
    frameList.push(Buffer.from(payload));
    // 实时转写：OPUS → PCM → 讯飞听写（无凭据时自动跳过）
    if (XF_CONFIG) {
      if (!transcriber) {
        transcriber = createLiveTranscriber(XF_CONFIG, {
          onText: text => {
            console.log(`[ASR] 会话${sessionId} ${text}`);
            // 实时辅助·关键词告警（AI-09 一期规则层；词表来自环境变量，与后台「风险预警/竞品库」保持一致）
            for (const w of ALERT_WORDS) {
              if (!firedAlerts.has(w) && text.includes(w)) {
                firedAlerts.add(w);
                console.log(`[ALERT] 会话${sessionId} 检测到关键词「${w}」（实时辅助规则触发）`);
              }
            }
          },
          onNotice: msg => console.log(`[ASR] 会话${sessionId} ${msg}`),
        });
      }
      transcriber.pushOpus(payload);
    }
    frameCount++;
    byteCount += payload.length;
    stats.totalFrames++;
    stats.totalBytes += payload.length;
    if (frameCount % 25 === 0) {
      process.stdout.write(`\r[REC] 会话${sessionId} 已收 ${frameCount} 帧 / ${(byteCount / 1024).toFixed(1)}KB OPUS   `);
    }
  });

  ws.on('close', () => {
    stats.activeWs--;
    const continuous = SESSION_MODE === 'continuous';
    let saved = '(无音频)';
    if (frameCount > 0 && !continuous) {
      oggPath = filePath;
      fs.writeFileSync(oggPath, buildOggOpus(frameList, frameMs));
      saved = `${path.basename(oggPath)} (${(fs.statSync(oggPath).size / 1024).toFixed(1)}KB)`;
    } else if (frameCount > 0 && continuous) {
      saved = `${frameCount} 帧入工作缓冲（收口时合并封装）`;
    }
    console.log(`\n[WS ] 会话${sessionId} 结束：共 ${frameCount} 帧，${(byteCount / 1024).toFixed(1)}KB OPUS → ${saved}`);
    if (transcriber) {
      transcriber.end(text => {
        if (text) {
          console.log(`[ASR] 会话${sessionId} 转写完成（${text.length} 字）`);
          console.log(`[ASR] ${text}`);
        } else {
          console.log(`[ASR] 会话${sessionId} 无转写内容`);
        }
        if (continuous) appendToBuffer(text || '');
        else ingestToServer(text || '');
      });
    } else if (continuous) {
      appendToBuffer('');
    } else {
      ingestToServer('');
    }
  });

  // continuous 模式：本 VAD 会话追加到设备工作会话缓冲（文本带时间前缀、音频帧入合并队列，不立即入库）
  function appendToBuffer(transcript) {
    const key = deviceId ? `xiaozhi-passport:${deviceId}` : 'unknown-device';
    const b = getBuffer(key);
    const now = Date.now();
    if (b.texts.length && b.lastActivityAt && now - b.lastActivityAt > GAP_CLOSE_MINUTES * 60000) {
      b.texts.push(`── 软分段（静音超 ${GAP_CLOSE_MINUTES} 分钟）──`); // 软分段标记：不终结当日缓冲
    }
    if (transcript) {
      const t = new Date();
      b.texts.push(`[${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}] ${transcript}`);
      b.segCount++;
    }
    b.frames = b.frames.concat(frameList);
    b.frameCount += frameCount;
    if (frameCount > 0) b.frameMs = frameMs;
    if (!b.startedAt) b.startedAt = now;
    b.lastActivityAt = now;
    saveSpool();
    console.log(`[BUF] 会话${sessionId} 追加至工作缓冲（累计 ${b.segCount} 段文本 / ${b.frameCount} 帧，等待 定时/手动 收口）`);
  }

  // 自动入库到管理后台（D13）：环境变量 BADGE_SERVER + BADGE_TOKEN（见后台「设置」页）
  function ingestToServer(transcript) {
    const base = process.env.BADGE_SERVER;
    if (!base || frameCount === 0 || !oggPath) return;
    const lfasrOn = XF_CONFIG && process.env.BADGE_LFASR !== 'off';
    fetch(base.replace(/\/$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': process.env.BADGE_TOKEN || '' },
      body: JSON.stringify({
        created_at: new Date().toISOString(),
        duration_s: frameCount * frameMs / 1000,
        audio_path: path.resolve(oggPath),
        transcript,
        device: deviceId ? `xiaozhi-passport:${deviceId}` : '',
        device_model: 'ai-passport',
        owner: '',
        topic: '',
      }),
      signal: AbortSignal.timeout(8000),
    }).then(r => r.json()).then(d => {
      if (d.id) {
        console.log(`[API] 已入库后台 comm#${d.id}${d.analyzed ? '（自动分析完成）' : ''}`);
        if (lfasrOn) runSpeakerDiarization(d.id, oggPath);
      } else {
        console.log(`[API] 入库被拒: ${d.error || JSON.stringify(d)}`);
      }
    }).catch(e => console.log(`[API] 入库失败: ${e.message}`));
  }

  // 入库后异步跑说话人分离 → runSpeakerDiarization（已提升至模块级，收口聚合入库也复用）
  ws.on('error', (e) => console.log(`[WS ] 错误: ${e.message}`));
});

// 入库后异步跑说话人分离（讯飞语音转写 lfasr，可能需数分钟）；成功回填后台并自动重出报告。
// 服务未开通/排队超时则静默失败，保留听写单人流文本（BADGE_LFASR=off 可关闭）。
function runSpeakerDiarization(commId, oggFile) {
  console.log(`[SPK] comm#${commId} 提交说话人分离（异步）…`);
  const child = spawn(process.execPath, [path.join(__dirname, 'asr-xf-transcribe.js'), oggFile], { stdio: 'ignore' });
  child.on('exit', code => {
    const spkFile = oggFile + '.spk.txt';
    if (code !== 0 || !fs.existsSync(spkFile)) {
      return console.log(`[SPK] comm#${commId} 分离未完成（语音转写服务未开通或排队超时），保留听写文本`);
    }
    const spkText = fs.readFileSync(spkFile, 'utf8');
    const base = process.env.BADGE_SERVER;
    if (!base) return;
    fetch(base.replace(/\/$/, '') + `/api/communications/${commId}/transcript`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': process.env.BADGE_TOKEN || '' },
      body: JSON.stringify({ transcript: spkText }),
      signal: AbortSignal.timeout(120_000),
    }).then(r => r.json()).then(d => {
      console.log(`[SPK] comm#${commId} ${d.ok ? `说话人转写已回填${d.analyzed ? '，报告已按角色重出' : ''}` : '回填失败: ' + (d.error || '?')}`);
    }).catch(e => console.log(`[SPK] comm#${commId} 回填异常: ${e.message}`));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  BadgeCore 接收服务端 v0.4（录制 + 实时转写 + 会话模式）');
  console.log(`  监听 0.0.0.0:${PORT}`);
  console.log(`  会话模式:  ${SESSION_MODE}${SESSION_MODE === 'continuous' ? `（软分段 ${GAP_CLOSE_MINUTES}min / 每日 ${DAILY_CLOSE_TIME} / POST /session/close 手动收口）` : '（一次 VAD 会话=一条记录）'}`);
  console.log(`  OTA 接口:  http://<本机IP>:${PORT}/xiaozhi/ota/`);
  console.log(`  音频通道:  ws://<本机IP>:${PORT}/xiaozhi/v1/`);
  console.log(`  录制目录:  ${SESSIONS_DIR}`);
  console.log(`  实时转写:  ${XF_CONFIG ? '已启用（讯飞流式听写）' : '未启用（缺凭据，仅录制；配置见 asr.config.example.json）'}`);
  console.log(`  自动入库:  ${process.env.BADGE_SERVER ? `→ ${process.env.BADGE_SERVER}` : '未启用（设 BADGE_SERVER/BADGE_TOKEN 环境变量，令牌见后台设置页）'}`);
  console.log('==============================================');
});

process.on('SIGINT', () => {
  console.log(`\n\n汇总：会话 ${stats.sessions}，总帧数 ${stats.totalFrames}，总 OPUS 数据 ${(stats.totalBytes / 1024).toFixed(1)}KB`);
  process.exit(0);
});
