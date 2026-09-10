/**
 * 裸 Opus 帧流（16字节头+payload 连续流）→ 合法 Ogg Opus 容器
 * 用法: node wrap-ogg.js <in.opus> <out.ogg>
 * 注：receiver.js 已内置 Ogg 封装（推荐）；本工具仅用于修复旧格式裸流文件。
 */
const fs = require('fs');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('用法: node wrap-ogg.js in.opus out.ogg'); process.exit(1); }

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
  crcTable[i] = r >>> 0;
}
function oggCrc(buf) {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ crcTable[((crc >>> 24) & 0xff) ^ b]) >>> 0;
  return crc >>> 0;
}

const SERIAL = 0x42414447;
let pageSeq = 0;
function makePage(granule, headerType, packets) {
  const segTable = [];
  for (const p of packets) {
    const full = Math.floor(p.length / 255);
    for (let i = 0; i < full; i++) segTable.push(255);
    segTable.push(p.length % 255);
  }
  const header = Buffer.alloc(27 + segTable.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = headerType;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(SERIAL, 14);
  header.writeUInt32LE(pageSeq++, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segTable.length;
  segTable.forEach((s, i) => { header[27 + i] = s; });
  const page = Buffer.concat([header, Buffer.concat(packets)]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

// 读裸帧流: 16字节头 + payload
const raw = fs.readFileSync(inPath);
const frames = [];
let off = 0;
while (off + 16 <= raw.length) {
  const size = raw.readUInt32BE(off + 12);
  if (off + 16 + size > raw.length) break;
  frames.push(raw.subarray(off + 16, off + 16 + size));
  off += 16 + size;
}
console.log(`读取 ${frames.length} 个 Opus 帧, 共 ${frames.reduce((a, f) => a + f.length, 0)} 字节`);
if (!frames.length) { console.error('没有帧, 检查输入'); process.exit(1); }

const opusHead = Buffer.alloc(19);
opusHead.write('OpusHead', 0, 'ascii');
opusHead[8] = 1; opusHead[9] = 1;
opusHead.writeUInt16LE(0, 10);
opusHead.writeUInt32LE(16000, 12);
opusHead.writeInt16LE(0, 16);
opusHead[18] = 0;
const opusTags = Buffer.alloc(16);
opusTags.write('OpusTags', 0, 'ascii');
opusTags.writeUInt32LE(0, 8);
opusTags.writeUInt32LE(0, 12);

const GRAN_PER_FRAME = 2880;
const pages = [makePage(0, 0, 0x02, [opusHead]), makePage(0, 0, 0x00, [opusTags])];
let granule = 0;
for (let i = 0; i < frames.length; i += 50) {
  const chunk = frames.slice(i, i + 50);
  granule = (i + chunk.length) * GRAN_PER_FRAME;
  const isLast = i + chunk.length >= frames.length;
  pages.push(makePage(granule, isLast ? 0x04 : 0x00, chunk));
}
fs.writeFileSync(outPath, Buffer.concat(pages));
console.log(`写出 ${outPath}: ${pages.length} pages, 时长约 ${(frames.length * 0.06).toFixed(1)} 秒`);
