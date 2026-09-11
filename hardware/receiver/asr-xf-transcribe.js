/**
 * BadgeCore 云 ASR · 讯飞语音转写（lfasr，录音文件版，带说话人分离）
 * --------------------------------------------------------------------------
 * 与流式听写互补（06 册 AI-01/AI-03）：听写管实时字幕（单人），本脚本管会后
 * 「谁在什么时间说了什么」——多人销售对话的分析基础（REC-13 P0）。
 *
 * 协议（官方文档 https://www.xfyun.cn/doc/asr/lfasr/API.html，2026-09 核对）：
 * - 五步：prepare → upload(multipart, 串行分片) → merge → getProgress 轮询 → getResult
 * - 签名 signa = base64( HmacSHA1( MD5(appid+ts), api_secret ) )，ts 为秒级
 * - has_seperate=true 开分离；speaker_number 0=盲分（自动估计人数）
 * - 结果为句子数组：{bg,ed(毫秒), onebest, speaker(1起, 0=未开分离)}
 * - ⚠️ 不支持 ogg 容器 → 本脚本先经 decode-pcm.py 解码并封装 WAV 再上传
 * - ⚠️ 需在控制台单独订阅「语音转写」并购买/领取时长；短音频可能排队（SLA 最长 5h，一般分钟级）
 *
 * 用法：node asr-xf-transcribe.js <音频文件> [--speakers 0]
 *   --speakers 0 盲分（默认）｜2..10 指定人数
 * 输出：<文件>.spk.txt（说话人对话体）+ <文件>.spk.json（原始句子数组，供后台入库）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./xfyun-iat');

const BASE = 'https://raasr.xfyun.cn/api';
const ERRORS = {
  26601: '签名/应用信息错误（检查 appid/api_key/api_secret，及「语音转写」是否已订阅）',
  26602: 'task_id 不存在',
  26603: '请求频率受限（1 秒内 >20 次）',
  26604: 'getResult 调用超限（100 次）',
  26605: '任务处理中，稍后重试',
  26621: '音频超过 5 小时上限', 26622: '音频大小超过 500MB',
  26623: '音频格式受限（本脚本已转 WAV，若仍报错请检查源文件）',
  26625: '服务时长不足，请到控制台购买/领取', 26633: '并发超限或时长不足',
  26643: '音频可能加密或损坏', 26650: '音频解码失败',
};

function signa(appId, apiSecret, ts) {
  const md5 = crypto.createHash('md5').update(appId + ts).digest('hex');
  return crypto.createHmac('sha1', apiSecret).update(md5).digest('base64');
}

async function postForm(endpoint, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (data.ok !== 1) {
    const hint = ERRORS[data.errNo] || '';
    throw new Error(`${endpoint} 失败: errNo=${data.errNo} ${data.failed || ''} ${hint}`);
  }
  return data;
}

/** ogg → 16k/mono WAV（lfasr 不收 ogg；decode-pcm.py 解码 + Node 加 44 字节头） */
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
  return Buffer.concat([header, pcm]);
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const input = argv.find(a => !a.startsWith('--'));
  const speakers = Number(argv.includes('--speakers') ? argv[argv.indexOf('--speakers') + 1] : 0) || 0;
  if (!input || !fs.existsSync(input)) {
    console.log('用法: node asr-xf-transcribe.js <音频文件> [--speakers 0]');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg) process.exit(1);

  const wav = toWav(input);
  console.log(`已转 WAV：${(wav.length / 1024 / 1024).toFixed(2)}MB（${((wav.length - 44) / 32000).toFixed(1)}s），开始提交转写任务…`);

  const ts = Math.floor(Date.now() / 1000);
  const common = { app_id: cfg.appid, signa: signa(cfg.appid, cfg.apiSecret, ts), ts: String(ts) };

  // 1) prepare（≤10MB 单片即可；一期会话录音远小于此）
  const sliceNum = Math.ceil(wav.length / (10 * 1024 * 1024)) || 1;
  const prep = await postForm('prepare', {
    ...common, file_len: String(wav.length), file_name: 'session.wav', slice_num: String(sliceNum),
    has_seperate: 'true', speaker_number: String(speakers), language: 'cn',
  });
  const taskId = prep.data;
  console.log(`任务已创建: ${taskId}（说话人分离=开，盲分=${speakers === 0}）`);

  // 2) upload（multipart，串行分片；slice_id 从 aaaaaaaaaa 起按 a-z 进位）
  const sliceIds = [];
  for (let i = 0; i < sliceNum; i++) {
    let id = '';
    let n = i;
    for (let p = 0; p < 10; p++) { id = String.fromCharCode(97 + (n % 26)) + id; n = Math.floor(n / 26); }
    while (id.length < 10) id = 'a' + id;
    sliceIds.push(id);
  }
  for (let i = 0; i < sliceNum; i++) {
    const start = i * 10 * 1024 * 1024;
    const slice = wav.subarray(start, Math.min(start + 10 * 1024 * 1024, wav.length));
    const fd = new FormData();
    fd.append('app_id', common.app_id); fd.append('signa', common.signa); fd.append('ts', common.ts);
    fd.append('task_id', String(taskId)); fd.append('slice_id', sliceIds[i]);
    fd.append('content', new Blob([slice]), `slice-${i}.wav`);
    const res = await fetch(`${BASE}/upload`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120_000) });
    const data = await res.json();
    if (data.ok !== 1) throw new Error(`upload 失败: errNo=${data.errNo} ${ERRORS[data.errNo] || ''}`);
    console.log(`分片 ${i + 1}/${sliceNum} 上传完成`);
  }

  // 3) merge
  await postForm('merge', { ...common, task_id: String(taskId), file_name: 'session.wav' });
  console.log('分片合并完成，等待转写…');

  // 4) getProgress 轮询（status=9 可取结果；短音频一般几十秒）
  const beganAt = Date.now();
  let status = 0;
  while (status !== 9) {
    await new Promise(r => setTimeout(r, 5000));
    const prog = await postForm('getProgress', { ...common, task_id: String(taskId) });
    const info = JSON.parse(prog.data);
    status = info.status;
    if (status !== 9) {
      console.log(`  转写中… status=${status}（${((Date.now() - beganAt) / 1000).toFixed(0)}s）`);
      if (Date.now() - beganAt > 30 * 60 * 1000) throw new Error('轮询超时（30 分钟，SLA 最长 5h，可稍后用 task_id 重查）');
    }
  }

  // 5) getResult
  const result = await postForm('getResult', { ...common, task_id: String(taskId) });
  const sentences = JSON.parse(result.data);
  fs.writeFileSync(input + '.spk.json', JSON.stringify(sentences, null, 1), 'utf8');
  const text = sentences.map(s => `说话人${s.speaker || 1} [${fmtMs(s.bg)}] ${s.onebest}`).join('\n');
  fs.writeFileSync(input + '.spk.txt', text, 'utf8');
  const speakerSet = new Set(sentences.map(s => s.speaker || 1));
  console.log(`\n===== 转写完成：${sentences.length} 句，${speakerSet.size} 位说话人，耗时 ${((Date.now() - beganAt) / 1000).toFixed(0)}s =====`);
  console.log(text);
  console.log(`\n已保存: ${input}.spk.txt / ${input}.spk.json`);
}

main().catch(e => { console.error(`\n${e.message}`); process.exit(1); });
