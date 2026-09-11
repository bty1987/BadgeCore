/**
 * BadgeCore 云 ASR · 讯飞流式听写（v2 iat）文件转写客户端
 * ----------------------------------------------------
 * 输入任意音频（ogg/wav/mp3），先经 decode-pcm.py（PyAV）解码为 16k/mono/s16le PCM，
 * 再按官方建议 40ms/1280B 分片推流。讯飞单会话上限 60s，超长自动按 55s 分段串行识别。
 *
 * 协议依据（2026-09 官方文档 https://www.xfyun.cn/doc/asr/voicedictation/API.html）：
 * - 鉴权：host/date/authorization 以 query 参数附在 wss URL 后（非 header）
 * - 首帧 common+business+data(status=0)，中间帧 data(status=1, base64 audio)，结束帧 data(status=2)
 * - dwa=wpgs 动态修正：pgs=apd 追加 / pgs=rpl 按 rg 区间替换历史结果
 * - 单会话 ≤60s；累计 10s 不发数据服务端断开（我们 40ms 一片，不会触发）
 *
 * 准备：讯飞开放平台注册 → 控制台创建应用并订阅「语音听写（流式版）」→
 *   cp asr.config.example.json asr.config.json 填入 appid/api_key/api_secret
 *   （或环境变量 XF_APPID / XF_API_KEY / XF_API_SECRET）
 *
 * 用法：node asr-xunfei.js <音频文件>        # 结果打印并写入 <音频文件>.xf.txt
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

const HOST = 'iat-api.xfyun.cn';
const SEGMENT_SECONDS = 55;   // 单会话上限 60s，留余量
const FRAME_BYTES = 1280;     // 16k/16bit/mono 下 40ms 一片（官方建议）
const FRAME_INTERVAL_MS = 40;
const SEGMENT_TIMEOUT_MS = 90_000;

// 讯飞常见错误码（文档），便于排障
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

// ---------- 配置 ----------
function loadConfig() {
  if (process.env.XF_APPID && process.env.XF_API_KEY && process.env.XF_API_SECRET) {
    return { appid: process.env.XF_APPID, apiKey: process.env.XF_API_KEY, apiSecret: process.env.XF_API_SECRET };
  }
  const p = path.join(__dirname, 'asr.config.json');
  if (fs.existsSync(p)) {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c.appid && c.api_key && c.api_secret) {
      return { appid: c.appid, apiKey: c.api_key, apiSecret: c.api_secret };
    }
    console.error('错误: asr.config.json 字段不全（需 appid / api_key / api_secret）');
    process.exit(1);
  }
  console.error(`缺少讯飞凭据，二选一配置：
  1) cp asr.config.example.json asr.config.json 后填入控制台的 APPID / APIKey / APISecret
  2) 环境变量 XF_APPID / XF_API_KEY / XF_API_SECRET
获取：https://console.xfyun.cn 创建应用 → 订阅「语音听写（流式版）」WebAPI`);
  process.exit(1);
}

// ---------- 鉴权 URL ----------
function buildUrl({ apiKey, apiSecret }) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET /v2/iat HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  return `wss://${HOST}/v2/iat?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${HOST}`;
}

// ---------- wpgs 动态修正结果拼装 ----------
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

// ---------- 单段识别（55s 内 PCM） ----------
function recognizeSegment(cfg, pcm, startByte, endByte, label) {
  return new Promise((resolve, reject) => {
    const parser = createResultParser();
    const ws = new WebSocket(buildUrl(cfg));
    const beganAt = Date.now();
    let firstFrameSent = false;
    let sendTimer = null;
    let settled = false;

    const watchdog = setTimeout(() => {
      ws.terminate();
      finish(new Error(`[${label}] 识别超时（${SEGMENT_TIMEOUT_MS / 1000}s 无最终结果）`));
    }, SEGMENT_TIMEOUT_MS);

    function finish(err, text) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(sendTimer);
      try { ws.close(); } catch { /* 已关闭 */ }
      if (err) reject(err);
      else resolve(text);
    }

    ws.on('open', () => {
      // 首帧：业务参数 + 空音频
      ws.send(JSON.stringify({
        common: { app_id: cfg.appid },
        business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', ptt: 1 },
        data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
      }));
      firstFrameSent = true;

      let pos = startByte;
      sendTimer = setInterval(() => {
        if (pos >= endByte) {
          clearInterval(sendTimer);
          ws.send(JSON.stringify({ data: { status: 2 } }));
          return;
        }
        const chunk = pcm.subarray(pos, Math.min(pos + FRAME_BYTES, endByte));
        pos += FRAME_BYTES;
        ws.send(JSON.stringify({
          data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') },
        }));
      }, FRAME_INTERVAL_MS);
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.code !== 0) {
        const hint = ERROR_HINTS[msg.code] || msg.message || '';
        finish(new Error(`[${label}] 讯飞返回 code=${msg.code} ${msg.message} ${hint ? '→ ' + hint : ''}（sid=${msg.sid || '?'}，报工单用）`));
        return;
      }
      if (msg.data && msg.data.result) parser.feed(msg.data.result);
      if (msg.data && msg.data.status === 2) {
        console.log(`[${label}] 完成，耗时 ${((Date.now() - beganAt) / 1000).toFixed(1)}s`);
        finish(null, parser.text());
      }
    });

    ws.on('error', e => finish(new Error(`[${label}] WebSocket 错误: ${e.message}（无法连接时先查本机能否访问 wss://${HOST}）`)));
    ws.on('close', () => {
      if (!settled) {
        if (firstFrameSent && parser.text()) finish(null, parser.text());
        else finish(new Error(`[${label}] 连接在拿到结果前被关闭（多为鉴权问题，检查 Key 与系统时钟）`));
      }
    });
  });
}

// ---------- 主流程 ----------
async function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.log('用法: node asr-xunfei.js <音频文件>');
    process.exit(1);
  }
  const cfg = loadConfig();

  // 1) 解码为 PCM
  const pcmFile = path.join(os.tmpdir(), `badgecore-asr-${Date.now()}.pcm`);
  const decoded = spawnSync('python', [path.join(__dirname, 'decode-pcm.py'), input, pcmFile], { stdio: 'inherit' });
  if (decoded.status !== 0) {
    console.error('错误: PCM 解码失败（decode-pcm.py 依赖 PyAV: pip install av）');
    process.exit(1);
  }
  const pcm = fs.readFileSync(pcmFile);
  fs.unlinkSync(pcmFile);

  // 2) 分段识别
  const segBytes = SEGMENT_SECONDS * 32000; // 16k*2字节
  const segCount = Math.max(1, Math.ceil(pcm.length / segBytes));
  console.log(`音频 ${(pcm.length / 32000).toFixed(1)}s → ${segCount} 段识别（讯飞单会话上限 60s）`);

  const texts = [];
  const beganAt = Date.now();
  for (let i = 0; i < segCount; i++) {
    const start = i * segBytes;
    const end = Math.min(start + segBytes, pcm.length);
    texts.push(await recognizeSegment(cfg, pcm, start, end, `段${i + 1}/${segCount}`));
    console.log(`[段${i + 1}/${segCount}] ${texts[i] || '(无语音内容)'}`);
  }

  // 3) 输出
  const fullText = texts.join('');
  const outFile = input + '.xf.txt';
  fs.writeFileSync(outFile, fullText, 'utf8');
  console.log(`\n===== 讯飞听写结果（${(pcm.length / 32000).toFixed(1)}s 音频，总耗时 ${((Date.now() - beganAt) / 1000).toFixed(1)}s）=====`);
  console.log(fullText || '(无语音内容)');
  console.log(`\n已保存: ${outFile}`);
}

main().catch(e => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
