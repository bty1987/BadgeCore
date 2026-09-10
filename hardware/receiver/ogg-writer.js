/**
 * Ogg Opus 封装器（无外部依赖）
 * Ogg Opus 规范: OpusHead + OpusTags 两个首页, granule 按 48kHz 计(60ms帧=2880)
 */
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

const SERIAL = 0x42414447; // 'BADG'
function makePage(seq, granule, headerType, packets) {
  const segTable = [];
  for (const p of packets) {
    const full = Math.floor(p.length / 255);
    for (let i = 0; i < full; i++) segTable.push(255);
    segTable.push(p.length % 255);
  }
  const header = Buffer.alloc(27 + segTable.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = headerType; // 0x02 BOS / 0x04 EOS
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(SERIAL, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22); // CRC 占位
  header[26] = segTable.length;
  segTable.forEach((s, i) => { header[27 + i] = s; });
  const page = Buffer.concat([header, Buffer.concat(packets)]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/**
 * @param {Buffer[]} frames - 每个元素一个 Opus packet（已剥传输头）
 * @param {number} frameMs - 每帧毫秒数（默认 60）
 * @returns {Buffer} 合法 Ogg Opus 文件
 */
function buildOggOpus(frames, frameMs = 60) {
  const granPerFrame = Math.round(48000 * frameMs / 1000);
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'ascii');
  opusHead[8] = 1;                       // version
  opusHead[9] = 1;                       // channels
  opusHead.writeUInt16LE(0, 10);         // pre-skip
  opusHead.writeUInt32LE(16000, 12);     // input sample rate
  opusHead.writeInt16LE(0, 16);          // output gain
  opusHead[18] = 0;                      // mapping family
  const opusTags = Buffer.alloc(16);     // Magic(8) + vendor_len(4) + comment_count(4)
  opusTags.write('OpusTags', 0, 'ascii');
  opusTags.writeUInt32LE(0, 8);          // vendor length
  opusTags.writeUInt32LE(0, 12);         // comment count

  const pages = [makePage(0, 0, 0x02, [opusHead]), makePage(1, 0, 0x00, [opusTags])];
  let seq = 2;
  for (let i = 0; i < frames.length; i += 50) {
    const chunk = frames.slice(i, i + 50);
    const granule = (i + chunk.length) * granPerFrame;
    const isLast = i + chunk.length >= frames.length;
    pages.push(makePage(seq++, granule, isLast ? 0x04 : 0x00, chunk));
  }
  return Buffer.concat(pages);
}

module.exports = { buildOggOpus };
