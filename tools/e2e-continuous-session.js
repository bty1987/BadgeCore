/**
 * 会话模式（continuous）端到端验证：临时后台 + continuous receiver + 模拟设备推流两段
 * --------------------------------------------------------------------------------------------
 * 验证（09 册 INT-02，docs/会话模式设计）：
 *   ① VAD 会话结束不立即入库（工作缓冲累积，避免长会议碎片化）
 *   ② POST /session/close 手动收口 → 聚合为 1 条记录（文本拼接 + Ogg 合并封装）
 *   ③ 聚合记录正常入后台（topic=聚合记录，时长=各段之和）
 *
 * 用法：node tools/e2e-continuous-session.js（自选临时端口与临时库，跑完自动清理进程）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PORT = 8297;
const API = `http://localhost:${API_PORT}`;
const dbFile = path.join(os.tmpdir(), `badgecore-e2e-cont-${Date.now()}.db`);
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failed = 1;
};
const waitPort = async (port, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { await fetch(`http://localhost:${port}/`); return true; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  return false;
};
const run = (script, args, cwd) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [script, ...args], { cwd: cwd || ROOT, stdio: 'inherit' });
  p.on('exit', c => c === 0 ? resolve() : reject(new Error(`${script} exit ${c}`)));
});

(async () => {
  console.log('== continuous 会话模式端到端验证 ==');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')],
    { env: { ...process.env, PORT: String(API_PORT), DB_FILE: dbFile }, stdio: 'ignore' });
  try {
    if (!(await waitPort(API_PORT))) throw new Error('后台未就绪');
    const login = await fetch(API + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'admin123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const token = (await (await fetch(API + '/api/settings', { headers: { Cookie: cookie } })).json()).ingest_token;

    const rec = spawn(process.execPath, [path.join(ROOT, 'hardware/receiver/receiver.js')], {
      env: { ...process.env, BADGE_SERVER: API, BADGE_TOKEN: token, SESSION_MODE: 'continuous' }, stdio: 'inherit',
    });
    try {
      if (!(await waitPort(8100))) throw new Error('receiver 未就绪');
      await run(path.join(ROOT, 'hardware/receiver/sim-device.js'), ['--seconds', '1', '--pace', 'blast'], path.join(ROOT, 'hardware/receiver'));
      await new Promise(r => setTimeout(r, 1200));
      await run(path.join(ROOT, 'hardware/receiver/sim-device.js'), ['--seconds', '1', '--pace', 'blast'], path.join(ROOT, 'hardware/receiver'));
      await new Promise(r => setTimeout(r, 1200));

      let list = await (await fetch(API + '/api/communications', { headers: { Cookie: cookie } })).json();
      check('收口前不碎入库（两段 VAD 会话 → 0 条记录）', list.length === 0, `实际 ${list.length} 条`);

      const close = await (await fetch('http://localhost:8100/session/close', { method: 'POST' })).json();
      check('手动收口成功（closed=1）', close.ok === true && close.closed === 1, JSON.stringify(close));
      await new Promise(r => setTimeout(r, 1500));

      list = await (await fetch(API + '/api/communications', { headers: { Cookie: cookie } })).json();
      check('收口后聚合为 1 条记录', list.length === 1, `实际 ${list.length} 条`);
      check('聚合记录 topic 为「聚合记录」', /聚合记录/.test(list[0]?.topic || ''), list[0]?.topic);
      const detail = await (await fetch(`${API}/api/communications/${list[0].id}`, { headers: { Cookie: cookie } })).json();
      check('合并 Ogg 落盘且时长=两段之和（≈2s）', /workbuf-.*\.ogg$/.test(detail.audio_path || '') && fs.existsSync(detail.audio_path) && Math.abs(detail.duration_s - 2) < 0.5,
        `audio=${detail.audio_path} dur=${detail.duration_s}`);
      check('合并 Ogg 可读（OPUS 魔数 OggS）', fs.readFileSync(detail.audio_path).subarray(0, 4).toString() === 'OggS');
    } finally { rec.kill(); }
  } catch (e) {
    console.error('E2E 异常:', e.message);
    failed = 1;
  } finally {
    srv.kill();
    for (const f of [dbFile, dbFile + '-journal', dbFile + '-wal', dbFile + '-shm']) { try { fs.unlinkSync(f); } catch { } }
  }
  console.log(failed ? '\n结果：存在失败项' : '\n结果：全部通过');
  process.exit(failed);
})();
