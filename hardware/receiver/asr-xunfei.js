/**
 * BadgeCore 云 ASR · 讯飞流式听写（v2 iat）文件转写客户端
 * ----------------------------------------------------
 * 输入任意音频（ogg/wav/mp3），先经 decode-pcm.py（PyAV）解码为 16k/mono/s16le PCM，
 * 再按官方建议 40ms/1280B 间隔推流。讯飞单会话上限 60s，超长自动按 55s 分段串行识别。
 * 会话与鉴权逻辑在 xfyun-iat.js（与实时转写 asr-live.js 共用）。
 *
 * 用法：node asr-xunfei.js <音频文件>        # 结果打印并写入 <音频文件>.xf.txt
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, openIatSession, FRAME_BYTES } = require('./xfyun-iat');

const SEGMENT_SECONDS = 55;      // 单会话上限 60s，留余量
const FRAME_INTERVAL_MS = 40;    // 官方建议发送间隔

// 单段识别：PCM 按实时节奏喂入（讯飞按 40ms/片接收）
function recognizeSegment(cfg, pcm, startByte, endByte, label) {
  return new Promise((resolve, reject) => {
    const beganAt = Date.now();
    const session = openIatSession(cfg, {
      onFinal: text => {
        console.log(`[${label}] 完成，耗时 ${((Date.now() - beganAt) / 1000).toFixed(1)}s`);
        resolve(text);
      },
      onError: e => reject(new Error(`[${label}] ${e.message}`)),
    });
    let pos = startByte;
    const timer = setInterval(() => {
      if (pos >= endByte) {
        clearInterval(timer);
        session.finish();
        return;
      }
      pos += FRAME_BYTES;
      session.pushPcm(pcm.subarray(pos - FRAME_BYTES, Math.min(pos, endByte)));
    }, FRAME_INTERVAL_MS);
  });
}

async function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.log('用法: node asr-xunfei.js <音频文件>');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!cfg) process.exit(1);

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
