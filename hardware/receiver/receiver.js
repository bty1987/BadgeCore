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

// 讯飞听写凭据（缺省则仅录制不转写；配置方法见 asr.config.example.json）
const XF_CONFIG = loadXfConfig(true);

// 实时辅助关键词（AI-09 一期规则层）：环境变量 XF_ALERT_KEYWORDS，逗号分隔，与后台竞品库/风险规则保持一致
const ALERT_WORDS = (process.env.XF_ALERT_KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean);

const stats = { sessions: 0, totalFrames: 0, totalBytes: 0, activeWs: 0 };

// ---------- HTTP：OTA 接口 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/xiaozhi/ota/' || url.pathname === '/xiaozhi/ota') {
    const host = req.headers.host || '';
    const wsHost = host.includes(':') ? host.split(':')[0] : host; // 设备与电脑同局域网，用同一 IP
    const body = {
      websocket: {
        url: `ws://${wsHost}:${PORT}/xiaozhi/v1/`,
        token: 'badgecore-dev',
        version: 2,
      },
      firmware: { version: '2.4.2', url: '' },
      server_time: { timestamp: Date.now(), timezone_offset: 480 },
    };
    console.log(`[OTA] ${new Date().toLocaleTimeString()} Device-Id=${req.headers['device-id'] || '?'} Client-Id=${req.headers['client-id'] || '?'} → 下发 ws://${wsHost}:${PORT}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------- WebSocket：音频流接收 ----------
const wss = new WebSocketServer({ server, path: '/xiaozhi/v1/' });

wss.on('connection', (ws, req) => {
  stats.activeWs++;
  stats.sessions++;
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
    let saved = '(无音频)';
    if (frameCount > 0) {
      oggPath = filePath;
      fs.writeFileSync(oggPath, buildOggOpus(frameList, frameMs));
      saved = `${path.basename(oggPath)} (${(fs.statSync(oggPath).size / 1024).toFixed(1)}KB)`;
    }
    console.log(`\n[WS ] 会话${sessionId} 结束：共 ${frameCount} 帧，${(byteCount / 1024).toFixed(1)}KB OPUS → ${saved}`);
    if (transcriber) {
      transcriber.end(text => {
        if (text) {
          const txtPath = filePath.replace(/\.ogg$/, '.xf.txt');
          fs.writeFileSync(txtPath, text, 'utf8');
          console.log(`[ASR] 会话${sessionId} 转写完成（${text.length} 字）→ ${path.basename(txtPath)}`);
          console.log(`[ASR] ${text}`);
        } else {
          console.log(`[ASR] 会话${sessionId} 无转写内容`);
        }
        ingestToServer(text || '');
      });
    } else {
      ingestToServer('');
    }
  });

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
        device: 'xiaozhi-1.75c',
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
  ws.on('error', (e) => console.log(`[WS ] 错误: ${e.message}`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  BadgeCore 接收服务端 v0.3（录制 + 实时转写）');
  console.log(`  监听 0.0.0.0:${PORT}`);
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
