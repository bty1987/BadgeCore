/**
 * 讯飞流式听写（v2 iat）共享客户端
 * --------------------------------
 * 被 asr-xunfei.js（文件转写）与 asr-live.js（实时转写）复用。
 * 协议要点（官方文档 https://www.xfyun.cn/doc/asr/voicedictation/API.html）：
 * - 鉴权 host/date/authorization 以 query 附在 wss URL 后
 * - 首帧 common+business+data(status=0)，音频帧 1280B/片（40ms@16k s16le mono），结束帧 status=2
 * - 单会话 ≤60s（上层负责 55s 换段）；累计 10s 不发数据服务端断开（由调用方保证持续供数）
 * - dwa=wpgs 动态修正：apd 追加 / rpl 按 rg 区间替换
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const IAT_HOST = 'iat-api.xfyun.cn';
const FRAME_BYTES = 1280; // 16k/16bit/mono 下 40ms 一片

const ERROR_HINTS = {
  401: '鉴权失败：检查 api_key/api_secret、系统时钟（允许偏移 300s 内）',
  403: '被拒绝：时钟偏移超限或 IP 白名单',
  10005: '用量超限（免费额度用完？控制台查看）',
  10105: 'app_id 未授权/未订阅「语音听写（流式版）」',
  10163: '参数缺失或非法',
  10165: '帧序非法：首帧必须含 status=0',
  10043: '音频解码失败：确认输入为 16k/8k 的 raw PCM',
  10114: '音频超过 60s 上限',
  10200: '发送间隔超时（累计 10s 未发数据）',
  11200: '功能未授权或总量超限',
};

/** 读取凭据：环境变量优先，其次 asr.config.json；silent=true 时不打印引导（调用方自行提示） */
function loadConfig(silent = false) {
  if (process.env.XF_APPID && process.env.XF_API_KEY && process.env.XF_API_SECRET) {
    return { appid: process.env.XF_APPID, apiKey: process.env.XF_API_KEY, apiSecret: process.env.XF_API_SECRET };
  }
  const p = path.join(__dirname, 'asr.config.json');
  if (fs.existsSync(p)) {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c.appid && c.api_key && c.api_secret) {
      return { appid: c.appid, apiKey: c.api_key, apiSecret: c.api_secret };
    }
    if (!silent) console.error('错误: asr.config.json 字段不全（需 appid / api_key / api_secret）');
    return null;
  }
  if (!silent) {
    console.error(`缺少讯飞凭据，二选一配置：
  1) cp asr.config.example.json asr.config.json 后填入控制台的 APPID / APIKey / APISecret
  2) 环境变量 XF_APPID / XF_API_KEY / XF_API_SECRET
获取：https://console.xfyun.cn 创建应用 → 订阅「语音听写（流式版）」WebAPI`);
  }
  return null;
}

function buildIatUrl(apiKey, apiSecret) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${IAT_HOST}\ndate: ${date}\nGET /v2/iat HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${IAT_HOST}/v2/iat?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${IAT_HOST}`;
}

/** wpgs 动态修正结果拼装 */
function createResultParser() {
  const pieces = new Map(); // 结果次序(1起) → 文本
  let seq = 0;
  return {
    feed(result) {
      const text = (result.ws || []).map(w => (w.cw || []).map(c => c.w).join('')).join('');
      seq += 1;
      if (result.pgs === 'rpl' && Array.isArray(result.rg)) {
        const [beg, end] = result.rg; // 替换第 beg~end 次返回的结果
        for (let i = beg; i <= end; i++) pieces.delete(i);
      }
      pieces.set(seq, text);
    },
    text() {
      return [...pieces.keys()].sort((a, b) => a - b).map(k => pieces.get(k)).join('');
    },
  };
}

/**
 * 打开一个听写会话（≤60s 音频；换段逻辑在上层）。
 * opts.onText(text)  收到增量时触发（参数=当前会话累计文本）
 * opts.onFinal(text) 会话最终文本（status=2 或对端带结果关闭）
 * opts.onError(err)  会话作废（上层自行决定重开）
 * 返回 controller：pushPcm(buf) 持续供数 / finish() 输入结束 / abort() 放弃
 */
function openIatSession(cfg, { onText, onFinal, onError } = {}) {
  const parser = createResultParser();
  const ws = new WebSocket(buildIatUrl(cfg.apiKey, cfg.apiSecret));
  let opened = false;
  let inputEnded = false; // 调用方已 finish
  let done = false;       // 已 onFinal / onError
  let buf = Buffer.alloc(0);

  const watchdog = setTimeout(() => {
    fail(new Error('听写会话超时（90s 无最终结果）'));
  }, 90_000);

  function cleanup() {
    clearTimeout(watchdog);
    try { ws.close(); } catch { /* 已关闭 */ }
  }
  function fail(e) {
    if (done) return;
    done = true;
    cleanup();
    if (onError) onError(e);
  }
  function ok() {
    if (done) return;
    done = true;
    cleanup();
    if (onFinal) onFinal(parser.text());
  }

  function sendFrame(chunk) {
    ws.send(JSON.stringify({
      data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') },
    }));
  }
  function flush() {
    while (opened && !inputEnded && buf.length >= FRAME_BYTES) {
      sendFrame(buf.subarray(0, FRAME_BYTES));
      buf = buf.subarray(FRAME_BYTES);
    }
  }

  ws.on('open', () => {
    opened = true;
    ws.send(JSON.stringify({
      common: { app_id: cfg.appid },
      // eos=10000：后端点静默检测放宽到 10s——默认 2000ms 会在说话停顿时被服务端提前结束会话，
      // 实时转写场景由 asr-live 层负责换段，减少无谓的会话重建
      business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', ptt: 1, eos: 10000 },
      data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
    }));
    flush();
    // finish() 先于 open 到达的情况
    if (inputEnded) {
      if (buf.length) { sendFrame(buf); buf = Buffer.alloc(0); }
      ws.send(JSON.stringify({ data: { status: 2 } }));
    }
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.code !== 0) {
      const hint = ERROR_HINTS[msg.code] || '';
      fail(new Error(`讯飞 code=${msg.code} ${msg.message || ''} ${hint ? '→ ' + hint : ''}（sid=${msg.sid || '?'}，报工单用）`));
      return;
    }
    if (!msg.data) return;
    if (msg.data.result) {
      parser.feed(msg.data.result);
      if (onText) onText(parser.text());
    }
    if (msg.data.status === 2) ok();
  });

  ws.on('error', e => fail(new Error(`WebSocket 错误: ${e.message}（无法连接时先查本机能否访问 wss://${IAT_HOST}）`)));
  ws.on('close', () => {
    if (!done) {
      if (parser.text()) ok(); // 对端带结果关闭
      else fail(new Error('连接在拿到结果前被关闭（多为鉴权问题，检查 Key 与系统时钟）'));
    }
  });

  return {
    pushPcm(chunk) {
      if (done || inputEnded) return;
      buf = Buffer.concat([buf, chunk]);
      flush();
    },
    finish() {
      if (done || inputEnded) return;
      inputEnded = true;
      if (opened) {
        if (buf.length) { sendFrame(buf); buf = Buffer.alloc(0); }
        ws.send(JSON.stringify({ data: { status: 2 } }));
      } // 未 open 时由 open 事件补发
    },
    abort() {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

module.exports = { loadConfig, buildIatUrl, createResultParser, openIatSession, FRAME_BYTES, ERROR_HINTS };
