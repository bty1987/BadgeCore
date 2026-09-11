/**
 * 模拟小智设备：连接 receiver，hello 握手后按 60ms 帧发送正弦音 OPUS 流
 * ------------------------------------------------------------------
 * 没有实体板子时测试「录音落盘 + 实时转写」全链路。
 *
 * 用法: node sim-device.js [--seconds 5] [--pace realtime|blast] [--url ws://localhost:8100/xiaozhi/v1/]
 *   realtime: 按 60ms 间隔实时发送（贴近真实设备，测 ASR 用）
 *   blast:    不加间隔瞬间发完（测录音落盘用）
 */
const { WebSocket } = require('ws');
const OpusScript = require('opusscript');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const SECONDS = Number(arg('seconds', 5));
const PACE = arg('pace', 'realtime');
const URL_ = arg('url', 'ws://localhost:8100/xiaozhi/v1/');

// 生成正弦 PCM 并编码为 60ms OPUS 包（440Hz，模拟持续语音占位）
const enc = new OpusScript(16000, 1, OpusScript.Application.VOIP);
const packets = [];
let t = 0;
const total = SECONDS * 16000;
while (t < total) {
  const pcm = Buffer.alloc(960 * 2);
  for (let i = 0; i < 960 && t + i < total; i++) {
    pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * (t + i) / 16000)), i * 2);
  }
  packets.push(enc.encode(pcm, 960));
  t += 960;
}
enc.delete();

// v2 二进制帧：version(u16BE) type(u8=1音频) reserved(u8) timestamp(u64BE) payload_size(u32BE)
function frame(pkt) {
  const head = Buffer.alloc(16);
  head.writeUInt16BE(2, 0);
  head.writeUInt8(1, 2);
  head.writeUInt8(0, 3);
  head.writeBigUInt64BE(BigInt(Date.now() * 1000), 4);
  head.writeUInt32BE(pkt.length, 12);
  return Buffer.concat([head, pkt]);
}

const ws = new WebSocket(URL_);
ws.on('open', () => {
  console.log(`已连接 ${URL_}，发送 hello…`);
  ws.send(JSON.stringify({
    type: 'hello', version: 2, transport: 'websocket',
    audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
  }));
});
ws.on('message', data => {
  if (data.toString().includes('"hello"')) {
    console.log(`收到 server hello，开始发送 ${packets.length} 帧（${SECONDS}s，pace=${PACE}）`);
    let i = 0;
    const send = () => {
      if (i >= packets.length) { console.log('发送完毕，断开'); ws.close(); return; }
      ws.send(frame(packets[i++]));
      if (PACE === 'realtime') setTimeout(send, 60); else send();
    };
    send();
  }
});
ws.on('error', e => { console.error(`连接失败: ${e.message}（receiver 起了吗？）`); process.exit(1); });
