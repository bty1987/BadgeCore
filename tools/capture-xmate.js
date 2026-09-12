/**
 * SaleSmart（x-mate.com）批量截图工具 —— 恢复 evidence 证据用
 * ------------------------------------------------------------
 * 原理：无头 Chrome + 复制的登录态 profile（含 Cookies）+ CDP 协议逐页导航截图。
 * 前置：
 *   1) 关闭正在运行的 Chrome（Cookies 文件锁定）
 *   2) 复制登录态配置到临时目录（robocopy，排除缓存），本脚本 --profile 指向它
 * 用法：node tools/capture-xmate.js [--profile <dir>] [--out evidence] [--wait 4000]
 * 输出：evidence/screenshots/xmate-<section>-<name>.jpg + evidence/pages/xmate-<name>.txt
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'hardware', 'receiver', 'node_modules', 'ws'));

const CHROME = 'C:/Users/Admin/AppData/Local/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const BASE = 'https://www.x-mate.com/#';

// 目标页面清单（2026-09 代码包路由解码 + 档案 §4）
const PAGES = [
  ['login', '登录页', '/login'],
  ['coach', '销售端首页', '/coach/home'],
  ['coach', '销售端沟通记录', '/coach/record'],
  ['coach', '销售端沟通计划', '/coach/plan'],
  ['coach', '销售端客户列表', '/coach/customer'],
  ['coach', '销售端线索', '/coach/lead'],
  ['coach', '销售端案例库', '/coach/library'],
  ['commander', '指挥舱工作台', '/commander/workbench'],
  ['commander', '运营看板', '/commander/ops_dashboard'],
  ['commander', '绩效', '/commander/performance'],
  ['commander', '团队报告', '/commander/report'],
  ['commander', '业务洞察', '/commander/business_insight'],
  ['commander', '团队客户', '/commander/customer'],
  ['commander', '团队成员', '/commander/employee'],
  ['admin', '信息收集', '/admin/info_collection'],
  ['admin', '成交模型', '/admin/transaction_model'],
  ['admin', '任务模型', '/admin/task_model'],
  ['admin', '能力模型', '/admin/ability_model'],
  ['admin', '沟通总结模板', '/admin/communication_summary'],
  ['admin', '沟通分析维度', '/admin/communication_analysis'],
  ['admin', '沟通流程', '/admin/communication_process'],
  ['admin', '竞争对手', '/admin/competitor'],
  ['admin', '违规检测', '/admin/violation_detection'],
  ['admin', '全局配置', '/admin/global_config'],
  ['admin', '客户列表', '/admin/customer_list'],
  ['admin', '客户字段', '/admin/customer_field_set'],
  ['admin', '客户状态', '/admin/customer_status'],
  ['admin', '客户类型', '/admin/customer_type'],
  ['admin', '画像配置', '/admin/portrait_config'],
  ['admin', '线索列表', '/admin/lead_list'],
  ['admin', '线索状态', '/admin/lead_status'],
  ['admin', '商机字段', '/admin/opportunity_field_settings'],
  ['admin', '洞察模板', '/admin/insight_template'],
  ['admin', '洞察分类', '/admin/insight_category'],
  ['admin', '访前准备', '/admin/pre_prepare'],
  ['admin', '访后分析', '/admin/post_analysis'],
  ['admin', '知识库', '/admin/knowledge_repository'],
  ['admin', '案例库管理', '/admin/library'],
  ['admin', '风险预警', '/admin/risk'],
  ['admin', '使用情况', '/admin/usage'],
  ['admin', '场景应对模型', '/admin/scenario_based_coping_model'],
  ['admin', '商品管理', '/admin/commodity'],
  ['admin', '产品类型', '/admin/product_type'],
  ['admin', '联系人字段', '/admin/contact_field'],
  ['admin', '联系人角色', '/admin/contact_role'],
  ['admin', '赋能教练配置', '/admin/coach_config'],
  ['admin', 'AskAI配置', '/admin/ask_ai'],
  ['admin', '机构要素', '/admin/org_factor'],
  ['manage', '部门管理', '/manage/department'],
  ['manage', '员工名册', '/manage/employee'],
  ['manage', '恢复账号', '/manage/account'],
  ['manage', '岗位管理', '/manage/position'],
  ['manage', '职级管理', '/manage/rank'],
  ['manage', '角色权限', '/manage/role'],
  ['manage', '用户组', '/manage/usergroup'],
  ['manage', '企业设置', '/manage/setting'],
];

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PROFILE = arg('profile', 'C:/Users/Admin/AppData/Local/Temp/xm-profile');
const OUT = arg('out', path.join(__dirname, '..', 'evidence'));
const WAIT = Number(arg('wait', 4000));

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
  });
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1680,1000', 'about:blank',
  ], { stdio: 'ignore' });
  console.log(`Chrome 无头实例已启动 (pid=${chrome.pid})`);

  // 等 CDP 就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await res.json();
      break;
    } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!targets) throw new Error('CDP 未就绪');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 100 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');

  const summary = [];
  for (const [section, name, route] of PAGES) {
    const url = BASE + route;
    try {
      await send(ws, 'Page.navigate', { url });
      await new Promise(r => setTimeout(r, WAIT));
      const shot = await send(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      const png = Buffer.from(shot.data, 'base64');
      const evalRes = await send(ws, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      const text = evalRes.result.value || '';
      const info = await send(ws, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const finalUrl = info.result.value || '';
      const redirected = finalUrl.includes('/login') && !route.startsWith('/login');
      const file = `xmate-${section}-${name}`;
      fs.writeFileSync(path.join(OUT, 'screenshots', file + '.jpg'), png);
      fs.writeFileSync(path.join(OUT, 'pages', file + '.txt'),
        `URL: ${finalUrl}\n重定向到登录页: ${redirected}\n时间: ${new Date().toISOString()}\n----\n${text}`);
      summary.push({ file, ok: !redirected && png.length > 8000 && text.length > 10, size: png.length, textLen: text.length, redirected });
      console.log(`${redirected ? '↪登录' : '  ✓  '} ${file}.jpg ${(png.length / 1024).toFixed(0)}KB 文本${text.length}字`);
    } catch (e) {
      summary.push({ file: `${section}-${name}`, ok: false, error: e.message });
      console.log(`  ✗ ${section}-${name}: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(OUT, 'capture-summary.json'), JSON.stringify(summary, null, 1));
  const okCount = summary.filter(s => s.ok).length;
  console.log(`\n完成：${okCount}/${summary.length} 页有效（明细 evidence/capture-summary.json）`);
  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch(e => { console.error('失败:', e); process.exit(1); });
