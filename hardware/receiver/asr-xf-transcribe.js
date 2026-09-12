/**
 * BadgeCore 云 ASR · 录音文件转写大模型（讯飞「非实时语音转写大模型」WebAPI，带说话人分离）
 * --------------------------------------------------------------------------------
 * ⚠️ 注意：讯飞已把老「语音转写」(raasr.xfyun.cn, HmacSHA1(MD5(appid+ts))) 升级为本产品，
 * 网关/鉴权/协议完全不同（2026-09 实测：老接口对新开通用户报 signa verify fail）。
 * 本脚本对接新版协议，官方文档 https://www.xfyun.cn/doc/spark/asr_llm/Ifasr_llm.html
 *
 * 协议要点：
 * - 两步：POST /v2/upload（二进制流，query 携带参数，header 带 signature）拿 orderId
 *         → POST /v2/getResult（空 JSON body {}，query 带 orderId）轮询至 status=4
 * - 鉴权：query 参数按名排序、值 URL 编码、k=v 用 & 连接成 baseString，
 *         signature = base64(HmacSHA1(baseString, APISecret))，放请求头 signature
 * - 角色分离：roleType=1（通用分离），roleNum 0=盲分；结果句级 st.rl 为角色编号（1 起）
 * - language=autodialect：中英 + 202 种方言免切
 * - 音频要求 16k/8k、16bit、单声道 → 复用 decode-pcm.py 转码后封装 WAV
 *
 * 用法：node asr-xf-transcribe.js <音频文件> [--speakers 0]
 *   --speakers 0 盲分（默认）｜2..10 指定人数
 * 输出：<文件>.spk.txt（说话人对话体）+ <文件>.spk.json（句子数组，供后台入库/分析）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./xfyun-iat');

const BASE = 'https://office-api-ist-dx.iflyaisol.com';

const ERRORS = {
  100007: '权限错误（免费额度未领取/已用尽？控制台查看「录音文件转写大模型」）',
  100008: '签名异常-请求时间超过限制（检查系统时钟）',
  100009: '签名校验不通过',
  100013: '订单未完成（继续轮询）',
  100012: '请求超过频率限制',
  100033: '无效的角色分离个数（范围 0-10）',
  100005: '查询音频为空',
};

/** 16 位随机串（大小写字母+数字） */
function random16() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

/** 本地时间带时区：yyyy-MM-dd'T'HH:mm:ss±HHmm */
function fmtDateTime(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/**
 * 构造带签名的请求。
 * @param params query 参数（不含 signature），空值不参与签名
 * @returns { url, headers }
 * ⚠️ signature 只放请求头（官方 demo 同款）——放 URL 会参与网关重算导致 100009
 */
function signedRequest(endpoint, params, body, contentType) {
  const used = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) used[k] = String(v);
  }
  const baseString = Object.keys(used).sort()
    .map(k => `${k}=${encodeURIComponent(used[k])}`).join('&');
  const signature = crypto.createHmac('sha1', loadConfigCache.apiSecret)
    .update(baseString, 'utf8').digest('base64');
  const query = Object.entries(used).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return {
    url: `${BASE}${endpoint}?${query}`,
    headers: { 'Content-Type': contentType, signature },
  };
}

let loadConfigCache;
async function post(endpoint, params, body, contentType) {
  const { url, headers } = signedRequest(endpoint, params, body, contentType);
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120_000) });
  const data = await res.json();
  if (data.code !== '000000') {
    throw Object.assign(new Error(`${endpoint} 失败: code=${data.code} ${data.descInfo || ''} ${ERRORS[data.code] || ''}`), { code: data.code });
  }
  return data;
}

/** ogg/任意音频 → 16k/mono WAV（大模型版要求 16k/8k、16bit、单声道）；返回 { buffer, durationMs } */
function toWav(input) {
  const pcmFile = path.join(os.tmpdir(), `badgecore-spk-${Date.now()}.pcm`);
  const r = spawnSync('python', [path.join(__dirname, 'decode-pcm.py'), input, pcmFile], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('PCM 解码失败（decode-pcm.py 依赖 PyAV）');
  const pcm = fs.readFileSync(pcmFile);
  fs.unlinkSync(pcmFile);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return { buffer: Buffer.concat([header, pcm]), durationMs: Math.round(pcm.length / 2 / 16000 * 1000) };
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 解析 orderResult（lattice[].json_1best 嵌套 JSON）→ 句子数组 */
function parseSentences(orderResult) {
  const lattice = JSON.parse(orderResult).lattice || [];
  const out = [];
  for (const item of lattice) {
    let best;
    try { best = JSON.parse(item.json_1best); } catch { continue; }
    const st = best.st;
    if (!st) continue;
    const text = (st.rt || []).flatMap(rt => (rt.ws || []))
      .flatMap(ws => (ws.cw || []))
      .filter(cw => cw.wp !== 's') // 顺滑词剔除
      .map(cw => cw.w).join('').trim();
    if (!text) continue;
    out.push({
      bg: Number(st.bg) || 0,
      ed: Number(st.ed) || 0,
      speaker: Number(st.rl) || 1, // 未开分离时无 rl，按 1
      text,
    });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const input = argv.find(a => !a.startsWith('--'));
  const speakers = Number(argv.includes('--speakers') ? argv[argv.indexOf('--speakers') + 1] : 0) || 0;
  if (!input || !fs.existsSync(input)) {
    console.log('用法: node asr-xf-transcribe.js <音频文件> [--speakers 0]');
    process.exit(1);
  }
  loadConfigCache = loadConfig();
  if (!loadConfigCache) process.exit(1);

  const { buffer: wav, durationMs } = toWav(input);
  console.log(`已转 WAV：${(wav.length / 1024 / 1024).toFixed(2)}MB（${(durationMs / 1000).toFixed(1)}s），提交「录音文件转写大模型」…`);

  // 1) 上传（二进制流；角色分离=通用，盲分/指定人数；参数对齐官方 demo：duration 毫秒）
  const uploadRandom = random16();
  const upload = await post('/v2/upload', {
    appId: loadConfigCache.appid,
    accessKeyId: loadConfigCache.apiKey,
    dateTime: fmtDateTime(),
    signatureRandom: uploadRandom,
    fileSize: String(wav.length),
    fileName: 'session.wav',
    language: 'autodialect',
    duration: String(durationMs),
    roleType: '1',
    roleNum: String(speakers),
  }, wav, 'application/octet-stream');
  const orderId = upload.content.orderId;
  console.log(`订单已创建: ${orderId}（角色分离=开，人数=${speakers || '盲分'}）`);

  // 2) 轮询结果（沿用上传的 signatureRandom；appId+ts 对齐官方 demo）
  const beganAt = Date.now();
  let sentences = null;
  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    const result = await post('/v2/getResult', {
      appId: loadConfigCache.appid,
      accessKeyId: loadConfigCache.apiKey,
      dateTime: fmtDateTime(),
      ts: String(Math.floor(Date.now() / 1000)),
      signatureRandom: uploadRandom,
      orderId,
    }, '{}', 'application/json');
    const info = result.content.orderInfo;
    if (info.status === 4) {
      sentences = parseSentences(result.content.orderResult || '');
      break;
    }
    if (info.status === -1) {
      throw new Error(`转写失败: failType=${info.failType}（${{ 1: '上传失败', 2: '转码失败', 3: '识别失败', 5: '时长校验失败', 6: '静音文件' }[info.failType] || '其他'}）`);
    }
    console.log(`  转写中… status=${info.status}（${((Date.now() - beganAt) / 1000).toFixed(0)}s）`);
    if (Date.now() - beganAt > 30 * 60 * 1000) throw new Error('轮询超时（30 分钟）');
  }

  // 3) 输出（与旧客户端保持相同契约，receiver 管道无需改动）
  fs.writeFileSync(input + '.spk.json', JSON.stringify(sentences, null, 1), 'utf8');
  const text = sentences.map(s => `说话人${s.speaker} [${fmtMs(s.bg)}] ${s.text}`).join('\n');
  fs.writeFileSync(input + '.spk.txt', text, 'utf8');
  const speakerSet = new Set(sentences.map(s => s.speaker));
  console.log(`\n===== 转写完成：${sentences.length} 句，${speakerSet.size} 位说话人，耗时 ${((Date.now() - beganAt) / 1000).toFixed(0)}s =====`);
  console.log(text);
  console.log(`\n已保存: ${input}.spk.txt / ${input}.spk.json`);
}

main().catch(e => { console.error(`\n${e.message}`); process.exit(1); });
