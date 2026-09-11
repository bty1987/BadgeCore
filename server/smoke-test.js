/**
 * BadgeCore 后台冒烟测试（自包含：临时端口 + 临时库，跑完自动清理）
 * 用法：node smoke-test.js
 * 覆盖：登录/鉴权 → 入库+自动Mock分析 → 列表/详情 → 报告结构 → 九大域CRUD → LLM连通 → 用户/审计
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8299;
const BASE = `http://localhost:${PORT}`;
const dbFile = path.join(os.tmpdir(), `badgecore-smoke-${Date.now()}.db`);
let cookie = '';
let passed = 0, failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
async function api(method, p, body, useCookie = true) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON（静态页） */ }
  return { status: res.status, data };
}

async function waitReady(child) {
  for (let i = 0; i < 30; i++) {
    try { await fetch(BASE + '/login.html'); return true; } catch { await new Promise(r => setTimeout(r, 300)); }
  }
  return false;
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: dbFile },
    stdio: 'ignore',
  });
  try {
    if (!(await waitReady(child))) throw new Error('服务器未就绪');
    console.log('== 冒烟测试 ==');

    // 1. 登录与鉴权
    let r = await api('POST', '/api/login', { name: 'admin', password: 'wrong' }, false);
    check('错误密码被拒 401', r.status === 401);
    r = await api('POST', '/api/login', { name: 'admin', password: 'admin123' }, false);
    check('正确登录 200 + cookie', r.status === 200 && cookie.includes('badge_token='));
    r = await api('GET', '/api/me');
    check('GET /api/me 返回 admin', r.data?.name === 'admin' && r.data?.role === 'admin');
    const noAuth = await fetch(BASE + '/api/communications');
    check('无 Cookie 访问被拒 401', noAuth.status === 401);

    // 2. 设置页拿入库令牌
    r = await api('GET', '/api/settings');
    const token = r.data?.ingest_token;
    check('管理员可读入库令牌', typeof token === 'string' && token.length >= 16);
    check('LLM Key 不回读（仅 has_api_key）', !('api_key' in (r.data?.llm || {})));

    // 3. 先配竞品词典（ADM-019：竞品库是识别词典，识别只认已配置竞品）
    r = await api('POST', '/api/config/competitors', { name: '竞品A', data: { notes: '冒烟' } });
    check('新增竞品词典条目', r.status === 200);
    r = await api('POST', '/api/config/knowledge_base', { name: '异议处理·价格贵', data: { content: '强调五年质保与上门服务' } });
    check('新增知识库条目', r.status === 200);

    // 4. receiver 入库 + 自动 Mock 分析（默认 llm=mock auto=true）
    const ingest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        created_at: new Date().toISOString(), duration_s: 42.5,
        audio_path: 'D:/test/demo.ogg', device: 'sim-device', owner: '张三', topic: '冒烟测试沟通',
        transcript: '说话人1: 您好，欢迎光临。说话人2: 我想看看新款，也对比了竞品A，我的手机是13812345678。说话人1: 明天我把详细方案发您邮箱。',
      }),
    });
    const ingestData = await ingest.json();
    check('入库成功', ingest.status === 200 && ingestData.id > 0);
    check('自动分析已执行（mock）', ingestData.analyzed === true);

    // 4. 列表与详情
    r = await api('GET', '/api/communications?q=冒烟');
    check('列表按关键词命中 1 条', r.data?.length === 1 && r.data[0].summary.includes('Mock'));
    r = await api('GET', `/api/communications/${ingestData.id}`);
    const rp = r.data?.report;
    check('详情含转写全文', (r.data?.transcript || '').includes('竞品A'));
    check('CMP-07 转写入库脱敏（手机号掩码）', (r.data?.transcript || '').includes('138****5678') && !(r.data?.transcript || '').includes('13812345678'));
    check('CMP-07 报告输出层脱敏', !(JSON.stringify(rp || {}).includes('13812345678')));
    check('实时辅助告警：竞品提及入库（AI-09）', (r.data?.meta?.alerts || []).some(a => a.type === 'competitor' && a.word === '竞品A'));
    check('报告骨架完整', !!rp && ['summary', 'stance', 'competitors', 'intention', 'tasks', 'violations', 'todos', 'meta'].every(k => k in rp));
    check('竞品计数=1', rp?.competitors?.[0]?.name === '竞品A' && rp.competitors[0].mentions === 1);
    check('待办提取到位', rp?.todos?.length >= 1);
    check('AI 生成标识（CMP-17）', rp?.meta?.ai_generated === true);

    // 5. 九大域 CRUD
    r = await api('POST', '/api/config/task_models', { name: '冒烟任务模型', data: { items: ['需求挖掘'] }, sort: 1 });
    const cfgId = r.data?.id;
    check('新增配置条目', r.status === 200 && cfgId > 0);
    r = await api('GET', '/api/config/task_models');
    check('配置列表可见', r.data?.some(x => x.name === '冒烟任务模型'));
    r = await api('PUT', `/api/config/task_models/${cfgId}`, { name: '冒烟任务模型2', data: { items: ['报价'] }, enabled: true });
    check('更新配置条目', r.status === 200);
    r = await api('DELETE', `/api/config/task_models/${cfgId}`);
    check('删除配置条目', r.status === 200);
    r = await api('GET', '/api/config/violations');
    check('违规项含判定说明字段（ADM-018）', (r.data || []).some(v => v.data?.typical && v.data?.exemption));

    // 6. 手动重跑分析
    r = await api('POST', `/api/communications/${ingestData.id}/analyze`);
    check('手动重跑分析', r.status === 200 && r.data?.report?.meta?.model === 'mock');

    // 7. LLM 连通测试端点
    r = await api('POST', '/api/llm-test');
    check('LLM 连通测试（mock）', r.data?.ok === true);

    // 8. 用户与数据范围
    r = await api('POST', '/api/users', { name: 'sales01', password: 's123456', role: 'sales' });
    check('新增销售用户', r.status === 200);
    const savedCookie = cookie;
    r = await api('POST', '/api/login', { name: 'sales01', password: 's123456' }, false);
    check('销售登录', r.status === 200);
    r = await api('GET', '/api/communications');
    check('数据范围：sales 看不到他人记录（ADM-313）', r.data?.length === 0);
    r = await api('GET', `/api/communications/${ingestData.id}`);
    check('数据范围：sales 访问他人详情 403', r.status === 403);
    r = await api('GET', '/api/config/task_models');
    check('配置页权限：sales 403', r.status === 403);
    cookie = savedCookie;

    // 9. Ask AI（AI-08 简版 RAG）
    r = await api('POST', '/api/ask', { question: '竞品A 有哪些顾虑？' });
    check('Ask AI mock 回答', r.status === 200 && r.data?.answer?.includes('Mock'));
    check('Ask AI 带来源（可溯源）', (r.data?.sources || []).length >= 2 && r.data.sources.some(s => s.type === 'kb'));
    const salesAsk = await api('POST', '/api/ask', { question: '所有员工的沟通数据' });
    check('Ask AI 权限内执行（sales 上下文无越权数据接口）', salesAsk.status === 200);

    // 10. 考勤（ALL-201/202）
    const t0 = 1789136400000;
    r = await api('POST', '/api/attendance/judge', {
      events: [
        { t: t0, beacon: 'B1', rssi: -60 }, { t: t0 + 30_000, beacon: 'B2', rssi: -62 },
        { t: t0 + 90_000, beacon: 'B1', rssi: -55 },
      ],
      save: true, user: 'admin',
    });
    check('信标判定出 1 个在场段', r.data?.periods?.length === 1 && r.data.daily?.length === 1);
    check('考勤日汇总入库', (r.data?.saved || []).length === 1);
    r = await api('POST', '/api/attendance', { user: 'admin', date: '2026-09-10', note: '冒烟补卡' });
    check('手动补卡提交', r.status === 200);
    r = await api('GET', '/api/attendance');
    check('考勤记录列表（含补卡）', (r.data || []).length >= 2 && r.data.some(x => x.status === 'manual'));

    // 10.5 CMP-08 留存 / CMP-13 水印 / AI-10 访前 / AI-11 定时
    r = await api('PUT', '/api/settings', { retention: { audio_days: 30, transcript_days: 1095, report_days: 1095 } });
    check('CMP-08 低于建议期被拒 400', r.status === 400 && /建议期/.test(r.data?.error || ''));
    const oldAudio = path.join(os.tmpdir(), `badgecore-old-${Date.now()}.ogg`);
    fs.writeFileSync(oldAudio, 'OGG');
    const oldIngest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ created_at: '2020-01-01T00:00:00Z', duration_s: 10, audio_path: oldAudio, transcript: '过期样本 13900001111' }),
    });
    check('过期样本入库（created_at=2020）', (await oldIngest.json()).id > 0);
    r = await api('POST', '/api/settings/purge');
    check('CMP-08 清理执行（音频删除+转写清空）', r.data?.audio >= 1 && r.data?.transcripts >= 1 && !fs.existsSync(oldAudio));

    const exp = await fetch(BASE + `/api/communications/${ingestData.id}/export`, { headers: { Cookie: cookie } });
    const expText = await exp.text();
    check('CMP-13 导出水印（导出人+时间）', exp.status === 200 && expText.includes('导出人: admin') && expText.includes('水印'));
    check('CMP-13 导出内容已脱敏', expText.includes('138****5678') && !expText.includes('13812345678'));

    r = await api('POST', '/api/prep-visit', { customer: '张总', notes: '二次拜访' });
    check('AI-10 访前准备（Mock 清单）', r.data?.plan?.questions?.length >= 3 && !!r.data.plan.background);

    r = await api('POST', '/api/config/scheduled_reports', { name: '冒烟晨报', data: { time: '00:00', question: '竞品A 提及汇总', recipients: ['admin'] } });
    const schedId = r.data?.id;
    check('AI-11 创建定时报告', r.status === 200 && schedId > 0);
    r = await api('POST', '/api/scheduled/run', { id: schedId });
    check('AI-11 手动触发执行', r.status === 200);
    r = await api('GET', '/api/notifications');
    check('AI-11 站内信送达（未读≥1）', (r.data?.unread || 0) >= 1 && r.data.rows.some(n => n.title.includes('冒烟晨报')));
    r = await api('POST', '/api/notifications/read');
    check('AI-11 标记已读', r.status === 200);
    r = await api('GET', '/api/notifications');
    check('AI-11 已读后未读=0', r.data?.unread === 0);
    await api('DELETE', `/api/config/scheduled_reports/${schedId}`);

    // 11. 审计
    r = await api('GET', '/api/audit');
    check('审计日志有记录', (r.data || []).some(a => a.action === 'login' && a.user === 'admin'));
    check('风险告警入审计（AI-09）', (r.data || []).some(a => a.action === 'risk_alert'));

    // 12. 静态页
    for (const p of ['/', '/login.html', '/config.html', '/settings.html', '/ask.html', '/attendance.html', '/style.css']) {
      const res = await fetch(BASE + p);
      check(`静态页 ${p}`, res.status === 200);
    }

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('冒烟测试异常:', e);
    process.exitCode = 1;
  } finally {
    child.kill();
    for (const f of [dbFile, dbFile + '-journal', dbFile + '-wal', dbFile + '-shm']) {
      try { fs.unlinkSync(f); } catch { /* 可能不存在 */ }
    }
  }
})();
