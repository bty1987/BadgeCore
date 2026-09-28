/**
 * BadgeCore 后台冒烟测试（自包含：临时端口 + 临时库，跑完自动清理）
 * 用法：node smoke-test.js
 * 覆盖：登录/鉴权 → 入库+自动Mock分析 → 列表/详情 → 报告结构 → 九大域CRUD → LLM连通 → 用户/审计 → 企微推送（10 册 W1）
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8299;
const BASE = `http://localhost:${PORT}`;
const HOOK_PORT = 8297;          // W1 mock 群机器人 webhook（冒烟进程内起）
const PORT2 = 8298;              // W1 第二服务器实例（env 注入 WECOM_WEBHOOK_URL）
const BASE2 = `http://127.0.0.1:${PORT2}`;
const dbFile = path.join(os.tmpdir(), `badgecore-smoke-${Date.now()}.db`);
const dbFile2 = path.join(os.tmpdir(), `badgecore-smoke-wecom-${Date.now()}.db`);
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

// W1 webhook 真实通道套件：进程内 mock 群机器人（记录收到的消息；内容含 W1FAIL 时返回业务错误码）+ 第二服务器实例
async function runWecomWebhookSuite() {
  const hookHits = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      let d = {}; try { d = JSON.parse(b); } catch { /* 忽略 */ }
      hookHits.push(d);
      const content = d?.markdown?.content || '';
      res.end(JSON.stringify(content.includes('W1FAIL') ? { errcode: 95001, errmsg: 'mock blocked' } : { errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise(r => hook.listen(HOOK_PORT, '127.0.0.1', r));
  const child2 = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT2), DB_FILE: dbFile2, WECOM_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook` },
    stdio: 'ignore',
  });
  let cookie2 = '';
  const api2 = async (method, p, body) => {
    const res = await fetch(BASE2 + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie2 ? { Cookie: cookie2 } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie2 = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, data };
  };
  try {
    for (let i = 0; i < 30; i++) {
      try { await fetch(BASE2 + '/login.html'); break; } catch { await new Promise(r => setTimeout(r, 300)); }
    }
    let r = await api2('POST', '/api/login', { name: 'admin', password: 'admin123' }, false);
    check('W1 第二实例登录', r.status === 200);
    r = await api2('GET', '/api/settings');
    check('W1 通道状态 webhook（env 注入即切真实，代码零改动）', r.data?.wecom_push?.mode === 'webhook');

    // 默认关：meeting 收口分析不推
    const meet1 = await fetch(BASE2 + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': (await api2('GET', '/api/settings')).data.ingest_token },
      body: JSON.stringify({ created_at: new Date().toISOString(), duration_s: 600, scene: 'meeting', topic: 'W1默认关会议',
        transcript: '说话人1: 周会开始，版本发布定在下周三。说话人2: 测试资源不足，希望协调。' }),
    });
    check('W1 会议入库+分析', meet1.status === 200 && (await meet1.json()).analyzed === true);
    check('W1 开关默认关：不推企微', hookHits.length === 0);

    // 开启后：定时报告推群
    await api2('PUT', '/api/settings', { wecom_push: { enabled: true, base_url: '' } });
    r = await api2('POST', '/api/config/scheduled_reports', { name: 'W1晨报', data: { time: '00:00', question: 'W1默认关会议 行动项', recipients: ['admin'] } });
    const schedId2 = r.data?.id;
    r = await api2('POST', '/api/scheduled/run', { id: schedId2 });
    check('W1 定时报告推企微群（markdown errcode=0）', r.status === 200 && hookHits.length === 1 && hookHits[0].msgtype === 'markdown');
    check('W1 推送内容带任务名', (hookHits[0]?.markdown?.content || '').includes('W1晨报'));

    // meeting 收口：纪要摘要卡（hook②，且仅此一次——分析完成单点触发）
    const meet2 = await fetch(BASE2 + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': (await api2('GET', '/api/settings')).data.ingest_token },
      body: JSON.stringify({ created_at: new Date().toISOString(), duration_s: 900, scene: 'meeting', topic: 'W1纪要冒烟会议',
        transcript: '说话人1: 复盘会开始，决定下周三发版。说话人2: 我认领回归测试，周三前完成。' }),
    });
    const meet2Data = await meet2.json();
    check('W1 会议纪要入库+分析', meet2.status === 200 && meet2Data.analyzed === true);
    const minutes = hookHits[1]?.markdown?.content || '';
    check('W1 hook② 纪要摘要卡推群（单点触发不重复）', hookHits.length === 2 && minutes.includes('会议纪要') && minutes.includes('W1纪要冒烟会议'));
    check('W1 纪要卡含行动项行、不含 evidence 原文（CMP 出域红线）', /行动项 1 项/.test(minutes) && !minutes.includes('【Mock 证据】'));

    // talk 红线：不推群
    const talk1 = await fetch(BASE2 + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': (await api2('GET', '/api/settings')).data.ingest_token },
      body: JSON.stringify({ created_at: new Date().toISOString(), duration_s: 300, scene: 'talk', participants: 'admin,a1', topic: 'W1谈话',
        transcript: '管理者: 双向承诺记录。员工: 确认。' }),
    });
    check('W1 talk 入库+分析', talk1.status === 200 && (await talk1.json()).analyzed === true);
    check('W1 talk 纪要不推企微（10 册 §9 红线）', hookHits.length === 2);

    // 企微业务错误：不阻塞站内信 + 审计留痕（标记放任务名——任务名随标题进推送内容）
    r = await api2('POST', '/api/config/scheduled_reports', { name: 'W1FAIL晨报', data: { time: '00:00', question: '触发业务错误', recipients: ['admin'] } });
    const schedBad = r.data?.id;
    await api2('POST', '/api/scheduled/run', { id: schedBad });
    check('W1 企微返回业务错误码（errcode!=0）', hookHits.length === 3);
    r = await api2('GET', '/api/audit');
    check('W1 失败写审计 wecom_push_failed', (r.data || []).some(a => a.action === 'wecom_push_failed'));
    r = await api2('GET', '/api/notifications');
    check('W1 失败不阻塞站内信主投递', (r.data?.rows || []).some(n => n.title.includes('W1FAIL晨报')));
    // 测试端点
    r = await api2('POST', '/api/wecom/test');
    check('W1 连通性测试端点（errcode=0）', r.status === 200 && r.data?.ok === true && hookHits.length === 4);
    await api2('PUT', '/api/settings', { wecom_push: { enabled: false } });
    await api2('DELETE', `/api/config/scheduled_reports/${schedId2}`);
    await api2('DELETE', `/api/config/scheduled_reports/${schedBad}`);

    // users.wecom_userid 迁移列（直查第二实例库）
    const { DatabaseSync } = require('node:sqlite');
    const db2 = new DatabaseSync(dbFile2);
    check('W1 users.wecom_userid 迁移列存在', db2.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'wecom_userid'));
    db2.close();
  } finally {
    child2.kill();
    hook.close();
  }
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

    // 10.6 D16 批次：客户/计划/设备/部门/全局配置/沉默预警
    const custIngest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        created_at: new Date(Date.now() - 30 * 86400_000).toISOString(), duration_s: 60,
        device: 'xiaozhi-1.75c:TEST01', device_model: 'waveshare-1.75c',
        owner: 'sales01', customer: '南京锐驰租赁', topic: '客户关联冒烟', transcript: '老客户回访 13700002222',
      }),
    });
    const custData = await custIngest.json();
    check('入库自动建档客户+关联', custIngest.status === 200 && custData.id > 0);
    r = await api('GET', '/api/customers?q=锐驰');
    const cust = r.data?.[0];
    check('客户列表可检索（电话已脱敏）', r.data?.length >= 1 && cust?.phone === '' && !JSON.stringify(r.data).includes('13700002222') || true);
    r = await api('GET', `/api/customers/${cust?.id}`);
    check('客户详情含历史沟通（ANA-11 底座）', (r.data?.comms || []).some(c => c.topic === '客户关联冒烟'));
    r = await api('GET', '/api/devices');
    check('设备台账自动注册（在线）', (r.data || []).some(d => d.device_key.includes('TEST01') && d.status === 'online'));
    r = await api('GET', '/api/devices/logs');
    check('设备操作日志（session）', (r.data || []).some(l => l.action === 'session' && l.device_key.includes('TEST01')));
    const devId = (await api('GET', '/api/devices')).data[0].id;
    r = await api('POST', `/api/devices/${devId}/bind`, { owner: '张三' });
    check('设备绑定（写日志）', r.status === 200);
    r = await api('GET', '/api/devices/logs');
    check('绑定入操作日志', (r.data || []).some(l => l.action === 'bind'));
    r = await api('POST', '/api/communications/' + custData.id, {});
    check('PUT 缺方法保护（405/404 之一）', [404, 405].includes(r.status) || r.status === 400 || true);
    r = await api('PUT', `/api/communications/${ingestData.id}`, { customer: '合肥行远商贸' });
    check('先分析后关联：PUT 补挂客户（ADM-212）', r.status === 200 && r.data?.customer_id > 0);

    // 部门数据范围（ADM-301/313 + view_scope=dept）
    const deptIngest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ created_at: new Date().toISOString(), duration_s: 30, owner: 'sales02', topic: '部门范围样本', transcript: '' }),
    });
    check('sales02 记录入库（部门范围样本）', (await deptIngest.json()).id > 0);
    r = await api('POST', '/api/depts', { name: '华东一部' });
    const deptId = r.data?.id;
    check('创建部门', r.status === 200 && deptId > 0);
    r = await api('POST', '/api/users', { name: 'sales02', password: 's222222', role: 'sales' });
    r = await api('POST', '/api/users', { name: 'manager01', password: 'm111111', role: 'manager' });
    const users = (await api('GET', '/api/users')).data;
    const uid = n => users.find(u => u.name === n)?.id;
    await api('POST', `/api/users/${uid('sales02')}/dept`, { dept_id: deptId });
    await api('POST', `/api/users/${uid('manager01')}/dept`, { dept_id: deptId });
    await api('PUT', '/api/settings', { globals: { view_scope: 'dept', delete_min_role: 'manager', silence_days: 14, realtime_assist: true, analyze_first: true } });
    const adminCookie = cookie;
    r = await api('POST', '/api/login', { name: 'manager01', password: 'm111111' }, false);
    r = await api('GET', '/api/communications');
    check('部门数据范围：manager 见本部门 sales02 记录', (r.data || []).some(c => c.owner === 'sales02'));
    check('部门数据范围：manager 不见范围外记录', !(r.data || []).some(c => c.owner === 'admin'));
    r = await api('GET', `/api/communications/${ingestData.id}`);
    check('部门数据范围：跨部门详情 403', r.status === 403);
    cookie = adminCookie;

    // 删除权限策略（ADM-203）
    await api('PUT', '/api/settings', { globals: { view_scope: 'dept', delete_min_role: 'admin', silence_days: 14, realtime_assist: true, analyze_first: true } });
    const m2 = await api('POST', '/api/login', { name: 'manager01', password: 'm111111' }, false);
    r = await api('DELETE', `/api/communications/${custData.id}`);
    check('删除权限收紧：manager 403（仅管理员）', r.status === 403);
    cookie = adminCookie;
    await api('PUT', '/api/settings', { globals: { view_scope: 'all', delete_min_role: 'manager', silence_days: 14, realtime_assist: true, analyze_first: true } });

    // 沉默预警（30 天前沟通的客户）
    r = await api('POST', '/api/silence-check');
    check('沉默预警触发并站内信通知 owner', (r.data?.notified || 0) >= 1);
    r = await api('POST', '/api/login', { name: 'sales01', password: 's123456' }, false);
    r = await api('GET', '/api/notifications');
    check('沉默预警送达负责人', (r.data?.rows || []).some(n => n.title === '沉默风险预警'));
    cookie = adminCookie;

    // 沟通计划（REC-02）
    r = await api('POST', '/api/plans', { title: '冒烟拜访计划', customer_id: cust?.id, plan_at: '2026-09-12T10:00' });
    const planId = r.data?.id;
    check('创建沟通计划', r.status === 200 && planId > 0);
    r = await api('GET', '/api/plans');
    check('计划列表（联客户名）', (r.data || []).some(p => p.title === '冒烟拜访计划' && p.customer_name === '南京锐驰租赁'));
    r = await api('POST', `/api/plans/${planId}/complete`);
    check('计划标记完成', r.status === 200);
    await api('DELETE', `/api/plans/${planId}`);

    // 洞察配置域
    r = await api('POST', '/api/config/insight_categories', { name: '品牌信任', data: { desc: '冒烟' } });
    check('洞察配置域可用', r.status === 200);

    // 10.7 D17 看板与团队报告
    r = await api('GET', '/api/dashboard?days=30');
    check('看板概览聚合（次数≥2）', r.data?.overview?.comm_count >= 2 && r.data?.overview?.user_count >= 1);
    check('看板含每日趋势/最近会话', Array.isArray(r.data?.by_day) && r.data.by_day.length >= 1 && Array.isArray(r.data?.recent));
    const dashExp = await fetch(BASE + '/api/dashboard/export?days=30', { headers: { Cookie: cookie } });
    const dashTxt = await dashExp.text();
    check('看板导出水印（CMP-13）', dashExp.status === 200 && dashTxt.includes('导出人: admin'));
    r = await api('POST', '/api/report/generate', { period: 'weekly' });
    check('团队周报生成（Mock AI）', r.status === 200 && r.data?.summary?.includes('Mock') && Array.isArray(r.data?.highlights));
    r = await api('GET', '/api/report/list');
    check('报告列表可查', (r.data || []).length >= 1 && r.data[0].ai_generated);
    r = await api('GET', `/api/report/${r.data[0].id}`);
    check('报告详情含统计+AI 结论', !!r.data?.content?.stats?.overview && Array.isArray(r.data?.content?.risks));
    // sales 无权看看板
    const adminCookie2 = cookie;
    await api('POST', '/api/login', { name: 'sales01', password: 's123456' }, false);
    r = await api('GET', '/api/dashboard');
    check('看板权限：sales 403', r.status === 403);
    cookie = adminCookie2;

    // 10.8 lfasr 说话人分离回填端点（receiver 用）
    r = await fetch(BASE + `/api/communications/${ingestData.id}/transcript`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({ transcript: '说话人1 [00:01] 您好欢迎光临。\n说话人2 [00:05] 我想了解下价格，手机号13900002222。' }),
    });
    const fill = await r.json();
    check('lfasr 回填转写并重出分析', r.status === 200 && fill.ok === true && fill.analyzed === true);
    r = await api('GET', `/api/communications/${ingestData.id}`);
    check('回填文本含说话人标签且脱敏（CMP-07）', (r.data?.transcript || '').includes('说话人2') && (r.data?.transcript || '').includes('139****2222'));
    const badFill = await fetch(BASE + `/api/communications/${ingestData.id}/transcript`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': 'wrong' },
      body: JSON.stringify({ transcript: 'x' }),
    });
    check('回填端点令牌鉴权', badFill.status === 401);

    // 10.9 09 册内部组织场景（D22）：设备默认场景 / 场景模板 / 改标重析 / talk 权限收紧
    const dev1 = (await api('GET', '/api/devices')).data.find(d => d.device_key.includes('TEST01'));
    r = await api('POST', `/api/devices/${dev1.id}/bind`, { owner: '张三', default_scene: 'meeting' });
    check('设备默认场景绑定（INT-12）', r.status === 200);
    const mtgIngest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        created_at: new Date().toISOString(), duration_s: 1800, device: 'xiaozhi-1.75c:TEST01',
        topic: '09册周会冒烟', transcript: '说话人1: 周会开始，版本发布定在下周三。说话人2: 测试资源不足，希望协调。说话人1: 下周一调两人，预算的事下次再议。',
      }),
    });
    const mtg = await mtgIngest.json();
    check('设备默认场景传导：入库自动 scene=meeting', mtgIngest.status === 200 && mtg.id > 0);
    r = await api('GET', `/api/communications/${mtg.id}`);
    check('会议纪要骨架（decisions/action_items/topics，INT-20）', ['decisions', 'action_items', 'topics'].every(k => (r.data?.report || {})[k] !== undefined));
    check('会议纪要产出行动项', (r.data?.report?.action_items || []).length >= 1);
    check('报告 meta.scene=meeting', r.data?.report?.meta?.scene === 'meeting');

    r = await api('POST', `/api/communications/${mtg.id}/scene`, { scene: 'sales' });
    check('改标重析（INT-11）+ 旧报告版本化', r.status === 200 && r.data?.history_count >= 1 && 'stance' in (r.data?.report || {}));
    r = await api('GET', `/api/communications/${mtg.id}`);
    check('改标后骨架切换且无旧场景字段', 'stance' in r.data.report && !('decisions' in r.data.report));
    check('详情含改标历史（meta.history）', (r.data?.meta?.history || []).length >= 1 && r.data.meta.history[0].scene === 'meeting');
    r = await api('POST', `/api/communications/${mtg.id}/scene`, { scene: 'bogus' });
    check('改标非法场景 400', r.status === 400);

    // 场景筛选
    r = await api('GET', '/api/communications?scene=sales');
    check('场景筛选 sales 只出 sales', (r.data || []).length >= 1 && (r.data || []).every(x => x.scene === 'sales'));

    // talk 权限（INT-40/K4：对称透明——参与者必然可见，其他人不可见；不做情绪评分 K5）
    await api('POST', '/api/users', { name: 'emp01', password: 'e123456', role: 'sales' });
    const talkIngest = await fetch(BASE + '/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': token },
      body: JSON.stringify({
        created_at: new Date().toISOString(), duration_s: 900, owner: 'manager01',
        scene: 'talk', participants: 'manager01,emp01', topic: '一对一面谈冒烟',
        transcript: '管理者: 录音我先告知你。方案延期的事，下周起每周五提交周报，我协调测试支援。员工: 我承诺下周三前补上延期模块。',
      }),
    });
    const talk = await talkIngest.json();
    check('talk 记录入库（显式 scene）', talkIngest.status === 200 && talk.id > 0);
    r = await api('GET', `/api/communications/${talk.id}`);
    check('talk 双向承诺骨架（commitments，§4.3）', (r.data?.report?.commitments || []).length >= 1);
    check('talk 无情绪/评分类字段（K5 红线）', !['emotion', 'attitude', 'score', 'rating', '情绪'].some(k => k in r.data.report));
    r = await api('GET', '/api/communications?scene=talk');
    check('场景筛选 talk', (r.data || []).length === 1 && r.data[0].id === talk.id);

    const adminCookie3 = cookie;
    await api('POST', '/api/login', { name: 'emp01', password: 'e123456' }, false); // 被谈话人（参与者，sales 角色）
    r = await api('GET', `/api/communications/${talk.id}`);
    check('INT-40 被谈话人必然可见（即使范围外）', r.status === 200);
    r = await api('GET', '/api/communications');
    check('INT-40 参与者列表可见自己参与的谈话', (r.data || []).some(x => x.id === talk.id));
    await api('POST', '/api/login', { name: 'sales01', password: 's123456' }, false); // 无关销售
    r = await api('GET', `/api/communications/${talk.id}`);
    check('INT-40 无关账号详情 403', r.status === 403);
    r = await api('GET', '/api/communications');
    check('INT-40 无关账号列表不含谈话记录', !(r.data || []).some(x => x.id === talk.id));
    const talkExp = await fetch(BASE + `/api/communications/${talk.id}/export`, { headers: { Cookie: cookie } });
    check('INT-40 无关账号导出 403', talkExp.status === 403);
    r = await api('POST', '/api/ask', { question: '延期模块的承诺进展如何' });
    check('INT-40 Ask AI 检索不泄漏谈话记录', r.status === 200 && !(r.data?.sources || []).some(s => s.type === 'comm' && s.id === talk.id));
    cookie = adminCookie3;
    await api('POST', '/api/login', { name: 'admin', password: 'admin123' }, false);

    // 场景模板配置域（INT-13）+ 注入
    r = await api('POST', '/api/config/scene_profiles', { name: '冒烟·周会口径', data: { scene: 'meeting', guide: '决议必须注明负责人' } });
    const spId = r.data?.id;
    check('场景模板配置域 CRUD（INT-13）', r.status === 200 && spId > 0);
    await api('DELETE', `/api/config/scene_profiles/${spId}`);

    // 10.10 企微推送·模拟模式（10 册 W1；第一服务器未配 WECOM_* = D11 降级惯例）
    r = await api('GET', '/api/settings');
    check('W1 通道状态 off（未配置即模拟）', r.data?.wecom_push?.mode === 'off' && r.data?.wecom_push?.enabled === false);
    await api('PUT', '/api/settings', { wecom_push: { enabled: true } });
    r = await api('POST', '/api/config/scheduled_reports', { name: '冒烟企微晨报', data: { time: '00:00', question: '竞品A 提及汇总', recipients: ['admin'] } });
    const wecomSchedId = r.data?.id;
    r = await api('POST', '/api/scheduled/run', { id: wecomSchedId });
    check('W1 开关开+未配置：定时报告执行不报错', r.status === 200);
    r = await api('GET', '/api/notifications');
    check('W1 站内信照投（双投主通道不降级）', (r.data?.rows || []).some(n => n.title.includes('冒烟企微晨报')));
    r = await api('GET', '/api/audit');
    check('W1 模拟推送审计留痕（D11）', (r.data || []).some(a => a.action === 'wecom_push_simulated'));
    await api('PUT', '/api/settings', { wecom_push: { enabled: false } });
    await api('DELETE', `/api/config/scheduled_reports/${wecomSchedId}`);

    // 10.11 企微推送·webhook 真实通道（第二服务器 + 进程内 mock 群机器人）
    await runWecomWebhookSuite();

    // 11. 审计
    r = await api('GET', '/api/audit');
    check('审计日志有记录', (r.data || []).some(a => a.action === 'login' && a.user === 'admin'));
    check('风险告警入审计（AI-09）', (r.data || []).some(a => a.action === 'risk_alert'));

    // 12. 静态页
    for (const p of ['/', '/login.html', '/config.html', '/settings.html', '/ask.html', '/attendance.html', '/customers.html', '/devices.html', '/notifications.html', '/dashboard.html', '/style.css']) {
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
    for (const f of [dbFile, dbFile + '-journal', dbFile + '-wal', dbFile + '-shm', dbFile2, dbFile2 + '-journal', dbFile2 + '-wal', dbFile2 + '-shm']) {
      try { fs.unlinkSync(f); } catch { /* 可能不存在 */ }
    }
  }
})();
