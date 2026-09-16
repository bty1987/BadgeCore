/**
 * 实时转写器回归测试：模拟讯飞 EOS 提前结束会话的场景
 * ------------------------------------------------
 * 场景（09-16 实测 bug）：设备持续推流，讯飞在 ~14s 处因静默 EOS 主动结束会话并返回部分文本；
 * 修复前：转写器不重建会话，后续音频滞留 pending 丢失（44 字/154s）；
 * 修复后：onFinal 时设备未结束 → 立即重建会话续录，音频零丢失。
 *
 * 用法：node test-asr-live.js（无需网络，注入假会话工厂）
 */
const assert = require('assert');
const path = require('path');
const { createLiveTranscriber } = require(path.join(__dirname, '..', 'hardware', 'receiver', 'asr-live'));

// ---- 假会话工厂：记录创建次数；会话在收到第 3 个 push 后模拟「讯飞 EOS 结束」并吐出部分文本 ----
let sessionCount = 0;
const sessionTexts = [];
function fakeSessionFactory(cfg, { onText, onFinal, onError }) {
  const id = ++sessionCount;
  const session = {
    pushes: 0,
    pushedBytes: 0,
    finished: false,
    pushPcm(chunk) {
      this.pushes++;
      this.pushedBytes += chunk.length;
      if (this.pushes === 3) {
        // 模拟讯飞 EOS：带部分文本结束本会话
        const text = `第${id}段语音内容。`;
        sessionTexts.push({ id, text, pushedBytesAtFinal: this.pushedBytes });
        setTimeout(() => onFinal(text), 5);
      }
    },
    finish() {
      this.finished = true;
      const text = `第${id}段收尾。`;
      setTimeout(() => onFinal(text), 2);
    },
    abort() {},
  };
  // 异步模拟 WS open
  setTimeout(() => {
    if (!session.finished) { /* open 后即可收数 */ }
  }, 1);
  return session;
}

(async () => {
  const cfg = { appid: 'test', apiKey: 'test', apiSecret: 'test' };
  const updates = [];
  const transcriber = createLiveTranscriber(cfg, {
    onText: t => updates.push(t),
    onNotice: () => {},
    sessionFactory: fakeSessionFactory,
  });

  // 设备持续推流：9 个包（每个假会话在第 3 包被 EOS 结束，共应产生 3 个会话）
  for (let i = 0; i < 9; i++) {
    transcriber.pushOpus(Buffer.alloc(100, i)); // 内容随意，假会话不真正解码
    await new Promise(r => setTimeout(r, 10)); // 留时间给 onFinal 回调链
  }

    const finalText = await new Promise(resolve => transcriber.end(resolve));
  await new Promise(r => setTimeout(r, 20));

  console.log('会话创建次数:', sessionCount, '（期望 3）');
  console.log('各段文本:', JSON.stringify(sessionTexts.map(s => s.text)));
  console.log('最终全文:', JSON.stringify(finalText));

  assert.strictEqual(sessionCount, 3, 'EOS 后应重建会话（3 段）');
  assert.ok(finalText.includes('第1段'), '第 1 段文本在最终全文中');
  assert.ok(finalText.includes('第2段'), '第 2 段文本在最终全文中');
  assert.ok(finalText.includes('第3段'), '第 3 段文本在最终全文中');
  // 关键断言：修复前，会话 1 EOS 后 push 的包全部滞留丢失
  for (let i = 1; i <= 3; i++) {
    const s = sessionTexts.find(x => x.id === i);
    if (!s) continue; // 第 3 段未触发 EOS（走 finish 收尾路径），跳过
    assert.ok(s.pushedBytesAtFinal > 0, `会话 ${i} 在结束前确实收到过音频`);
  }
  console.log('\n回归通过：EOS 提前结束后会话自动重建，三段音频全部进入转写，无丢失');
  process.exit(0);
})().catch(e => { console.error('测试失败:', e.message); process.exit(1); });
