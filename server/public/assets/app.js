/**
 * BadgeCore 前端公共工具（零依赖）
 * icon(): 内联线性 SVG 图标系统；api(); toast(); dlg(); 表格/表单渲染助手
 * Shell v3「淡蓝底分区」：单一壳 = 顶栏(搜索/通知/账户) + 侧栏(工作区切换器+菜单)
 * 销售工作台 / 管理后台 两侧同构，切换器带记忆（Ctrl+Shift+S 快速翻转）
 */
/* ---------- 图标库（24x24 线性，stroke 随 currentColor） ---------- */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  mic: '<path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  users: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-1a6 6 0 0 1 12 0v1"/><path d="M16 3.5a4 4 0 0 1 0 7M17 14a5 5 0 0 1 5 5v2"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M20 17H6.5a2.5 2.5 0 0 0 0 5H20"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 16v-5M13 16V8M18 16v-8"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 8h3a1 1 0 0 1 1 1v12M8 7h2M8 11h2M8 15h2M12 21v-4"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0z"/><path d="M7 5H4a3 3 0 0 0 3 5M17 5h3a3 3 0 0 1-3 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/>',
  alert: '<path d="M12 2L22 20H2z"/><path d="M12 9v5M12 17.5v.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12l5 5L20 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c1 .3 2 .6 3 .7a2 2 0 0 1 1.6 2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><circle cx="9" cy="14" r="1.1"/><circle cx="15" cy="14" r="1.1"/><path d="M12 8V4M9 4h6"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  'list-check': '<path d="M3 6l2 2 3-3M3 14l2 2 3-3M11 6h10M11 15h10"/>',
  gauge: '<path d="M20 14a8 8 0 1 0-16 0"/><path d="M12 14l4-5.5"/><circle cx="12" cy="14" r="1.3"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 8c6 2 2 6 8 8"/>',
  octagon: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z"/><path d="M12 8v4M12 16v.01"/>',
  flag: '<path d="M4 22V4c0 0 3-2 8 0s8 0 8 0v10c0 0-3 2-8 0s-8 0-8 0"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21.6l-.9-2.4-2.1-.9 2.1-.9z"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2.5"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8M12 17v4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
};
/** 输出内联线性 SVG 图标 */
function icon(name, size = 16, cls = '') {
  const p = ICONS[name];
  if (!p) return '';
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
async function api(path, opt = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opt,
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login.html'; return new Promise(() => {}); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { toast(data.error || ('请求失败 ' + r.status)); throw new Error(data.error || r.status); }
  return data;
}
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
/** 弹窗：dlg.open({title, body(html), foot([{label,cls,onClick}])}；返回 close 函数 */
function dlg() {
  const mask = document.createElement('div');
  mask.className = 'mask';
  document.body.appendChild(mask);
  const api = { close() { mask.remove(); } };
  return {
    open({ title, body, foot, wide }) {
      mask.classList.add('show');
      mask.innerHTML = `<div class="dialog" ${wide ? 'style="width:760px"' : ''}>
        <div class="dlg-head"><span>${title}</span><span class="x" id="_dx">×</span></div>
        <div class="dlg-body">${body}</div>
        <div class="dlg-foot" id="_df"></div></div>`;
      mask.querySelector('#_dx').onclick = api.close;
      mask.onclick = (e) => { if (e.target === mask) api.close(); };
      const footEl = mask.querySelector('#_df');
      (foot || [{ label: '取 消', cls: '', onClick: api.close }]).forEach(b => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (b.cls || '');
        btn.textContent = b.label;
        btn.onclick = () => b.onClick && b.onClick(api);
        footEl.appendChild(btn);
      });
      return api;
    },
    close: api.close,
  };
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtTime(s) { return s ? s.replace('T', ' ').slice(0, 16) : '-'; }
/** 通用表格渲染：renderTable(mount, columns, rows, ops) */
function renderTable(mount, columns, rows, ops) {
  if (!rows.length) {
    mount.innerHTML = `<div class="empty"><div class="empty-badge">${icon('inbox', 28)}</div>暂无数据</div>`;
    return;
  }
  const head = columns.map(c => `<th style="${c.w ? 'width:' + c.w : ''}">${c.title}</th>`).join('') + (ops ? '<th class="ops">操作</th>' : '');
  const body = rows.map((r, i) => '<tr>' + columns.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') +
    (ops ? `<td class="ops">${ops(r, i)}</td>` : '') + '</tr>').join('');
  mount.innerHTML = `<div style="background:var(--card);border-radius:10px;box-shadow:var(--shadow-card);overflow:hidden"><div style="overflow-x:auto"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

/* ================= Shell v3：单一壳 ================= */

const WS_HOME = { sales: '/index.html', admin: '/dashboard.html' };
/** 管理端落点：上次访问的管理页（initShell 写入），无记录回数据看板 */
const adminTarget = () => { try { return localStorage.getItem('bc.admin.last') || WS_HOME.admin; } catch { return WS_HOME.admin; } };
const WS_NAME = { sales: '销售工作台', admin: '管理后台' };
const WS_DESC = { sales: '我的沟通、客户与今日待办', admin: '九域配置、组织与数据看板' };
const WS_ICON = { sales: 'mic', admin: 'shield' };

/** 销售侧菜单（sales 角色无看板入口，服务端 403） */
function salesNav(role) {
  const N = [
    ['home', 'home', '首页', '/index.html'],
    ['comm', 'mic', '沟通', '/communications.html'],
    ['cust', 'users', '客户', '/customers.html'],
    ['cases', 'trophy', '案例库', '/cases.html'],
  ];
  if (role && role !== 'sales') N.push(['dash', 'chart', '看板', '/dashboard.html']);
  return N;
}
/** 管理侧菜单（组 → 项；key 与 config domain / 页面锚点一致） */
function adminNav() {
  return [
    ['沟通配置', 'sliders', [
      ['info_fields', 'file-text', '信息收集', '/config.html?domain=info_fields'],
      ['deal_models', 'target', '成交模型', '/config.html?domain=deal_models'],
      ['task_models', 'list-check', '任务模型', '/config.html?domain=task_models'],
      ['ability_models', 'gauge', '能力模型', '/config.html?domain=ability_models'],
      ['summary_templates', 'message', '沟通总结', '/config.html?domain=summary_templates'],
      ['analysis_dims', 'sliders', '沟通分析', '/config.html?domain=analysis_dims'],
      ['flows', 'route', '沟通流程', '/config.html?domain=flows'],
      ['violations', 'octagon', '违规检测', '/config.html?domain=violations'],
      ['competitors', 'flag', '竞争对手', '/config.html?domain=competitors'],
    ]],
    ['沟通计划', 'calendar', [['plans', 'calendar', '计划字段', '/config.html?domain=info_fields&group=plans']]],
    ['客户管理', 'users', [
      ['customers', 'users', '客户列表', '/customers.html'],
      ['cust_fields', 'file-text', '客户字段', '/config.html?domain=info_fields'],
      ['insight_categories', 'layers', '画像配置', '/config.html?domain=insight_categories'],
    ]],
    ['风险预警', 'alert', [['risk_rules', 'alert', '风险预警', '/config.html?domain=risk_rules']]],
    ['知识库', 'database', [
      ['knowledge_base', 'database', '知识库', '/config.html?domain=knowledge_base'],
      ['case_library', 'trophy', '案例库', '/config.html?domain=case_library'],
    ]],
    ['数据与设备', 'chart', [
      ['dashboard', 'chart', '数据看板', '/dashboard.html'],
      ['devices', 'monitor', '设备接入', '/devices.html'],
      ['attendance', 'calendar', '考勤统计', '/attendance.html'],
    ]],
    ['组织与人员', 'building', [
      ['org', 'building', '组织架构', '/org.html'],
      ['emp', 'user', '员工名册', '/org.html?tab=emp'],
      ['roles', 'shield', '角色权限', '/roles.html'],
    ]],
    ['全局', 'gear', [
      ['settings', 'gear', '全局配置', '/settings.html'],
      ['ask', 'bot', 'Ask AI', '/ask.html'],
    ]],
  ];
}

let _shellWS = 'sales';   // 当前页面所属工作区
let _shellMe = null;

function navHTML(ws, active, me) {
  const item = ([k, i, n, href]) =>
    `<a class="nav-item ${k === active ? 'on' : ''}" data-key="${k}" href="${href}">${icon(i, 16)}<span>${n}</span></a>`;
  if (ws === 'sales') return salesNav(me && me.role).map(item).join('');
  return adminNav().map(([g, gi, items]) =>
    `<div class="nav-group">${icon(gi, 12)}${g}</div>` + items.map(item).join('')
  ).join('');
}

function topbarHTML(me) {
  const canAdmin = me && me.role !== 'sales';
  return `<div class="topbar">
    <div class="brand"><span class="logo"></span>BadgeCore</div>
    <div class="global-search" id="gs">
      ${icon('search', 14)}<input id="gs-input" type="text" placeholder="搜索沟通、客户、配置…"><span class="kbd">Ctrl K</span>
    </div>
    <button class="top-ic" id="bell-btn" title="消息" aria-label="消息" onclick="location.href='/notifications.html'">${icon('bell', 17)}</button>
    <div class="account">
      <button class="avatar" id="av-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(me ? me.name : '')}">${esc((me && me.name || '我')[0])}</button>
      <div class="acc-menu" id="acc-menu" role="menu">
        <div class="acc-head"><b>${esc(me ? me.name : '')}</b><span>${esc(me ? me.role : '')}</span></div>
        ${canAdmin ? `<button onclick="location.href='/settings.html'">${icon('user', 14)}个人设置</button>` : ''}
        <button onclick="location.href='/api/logout'">${icon('logout', 14)}退出登录</button>
      </div>
    </div>
  </div>`;
}

function sidebarHTML(ws, active, me) {
  const canAdmin = me && me.role !== 'sales';
  return `<div class="sidebar">
    <button class="ws-btn" id="ws-btn" aria-haspopup="menu" aria-expanded="false" title="切换工作区 (Ctrl+Shift+S)">
      <span class="ws-chip" id="ws-chip" style="background:var(--primary-grad)">${icon(WS_ICON[ws], 14)}</span>
      <span class="ws-name">${WS_NAME[ws]}</span>
      <span class="ws-chev">${icon('chevdown', 14)}</span>
    </button>
    <nav class="nav-scroll" id="nav-scroll" data-active="${active}">${navHTML(ws, active, me)}</nav>
    ${ws === 'sales' ? `<div class="side-todo" id="side-todo"><div class="t">今日待办<span class="n" id="td-n">-</span><a class="more" href="/communications.html">全部</a></div><div id="td-rows"><div class="r empty">加载中…</div></div></div>` : ''}
  </div>
  <div class="ws-menu" id="ws-menu" role="menu" aria-label="切换工作区">
    <button class="ws-opt" role="menuitemradio" data-ws="sales" aria-checked="${ws === 'sales'}">
      <span class="ws-chip" style="background:var(--primary-grad)">${icon('mic', 14)}</span>
      <span style="min-width:0"><span class="t">销售工作台 <span class="ck">${icon('check', 14)}</span></span><span class="d">${WS_DESC.sales}</span></span>
    </button>
    ${canAdmin ? `<button class="ws-opt" role="menuitemradio" data-ws="admin" aria-checked="${ws === 'admin'}">
      <span class="ws-chip" style="background:linear-gradient(135deg,#1F2329,#51565F)">${icon('shield', 14)}</span>
      <span style="min-width:0"><span class="t">管理后台 <span class="ck">${icon('check', 14)}</span></span><span class="d">${WS_DESC.admin}</span></span>
    </button>` : ''}
    <div class="ws-foot">Ctrl+Shift+S 快速切换</div>
  </div>`;
}

function wireShell() {
  const wsBtn = document.getElementById('ws-btn');
  const wsMenu = document.getElementById('ws-menu');
  const openWS = () => {
    const r = wsBtn.getBoundingClientRect();
    wsMenu.style.left = r.left + 'px';
    wsMenu.style.top = (r.bottom + 6) + 'px';
    wsMenu.classList.add('show');
    wsBtn.setAttribute('aria-expanded', 'true');
  };
  const closeWS = () => { wsMenu.classList.remove('show'); wsBtn.setAttribute('aria-expanded', 'false'); };
  wsBtn.addEventListener('click', (e) => { e.stopPropagation(); wsMenu.classList.contains('show') ? closeWS() : openWS(); });
  wsMenu.addEventListener('click', (e) => e.stopPropagation());
  wsMenu.querySelectorAll('.ws-opt').forEach(o => o.addEventListener('click', () => {
    const t = o.dataset.ws;
    if (t === _shellWS) { closeWS(); return; }
    location.href = t === 'admin' ? adminTarget() : WS_HOME.sales;
  }));
  document.addEventListener('click', () => {
    if (wsMenu) closeWS();
    const am = document.getElementById('acc-menu');
    if (am) { am.classList.remove('show'); document.getElementById('av-btn').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeWS(); const am = document.getElementById('acc-menu'); if (am) am.classList.remove('show'); }
    const canAdmin = _shellMe && _shellMe.role !== 'sales';
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'S' || e.key === 's') && canAdmin) {
      e.preventDefault();
      const t = _shellWS === 'sales' ? 'admin' : 'sales';
      location.href = t === 'admin' ? adminTarget() : WS_HOME.sales;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const gi = document.getElementById('gs-input');
      if (gi) gi.focus();
    }
  });
  // 全局搜索扩域（M4）：聚合建议（沟通/客户/知识·案例按权限）+ Ask AI 兜底
  const gs = document.getElementById('gs-input');
  if (gs) {
    let panel = null, hlIdx = -1, debounce = null, results = [];
    const closePanel = () => { if (panel) { panel.remove(); panel = null; } hlIdx = -1; results = []; };
    const iconFor = { comm: 'mic', cust: 'users', kb: 'database', case: 'trophy' };
    const go = (item) => { closePanel(); gs.value = ''; location.href = item.href; };
    const render = (groups, q) => {
      closePanel();
      results = groups.flatMap(g => g.items);
      if (!results.length && !q) return;
      panel = document.createElement('div');
      panel.className = 'gs-panel show';
      const r = gs.getBoundingClientRect();
      panel.style.left = Math.max(12, r.left + r.width / 2 - 230) + 'px';
      panel.style.top = (r.bottom + 8) + 'px';
      if (!results.length) panel.innerHTML = `<div class="gs-empty">没有匹配的沟通 / 客户${_shellMe && _shellMe.role !== 'sales' ? ' / 配置' : ''}</div>`;
      else {
        panel.innerHTML = groups.filter(g => g.items.length).map(g => `
          <div class="gs-group">${g.name}</div>` +
          g.items.map(it => `<div class="gs-item" data-idx="${it.idx}">${icon(iconFor[it.kind] || 'search', 15)}<span class="t">${it.t}</span><span class="d">${it.d || ''}</span></div>`).join('')
        ).join('');
      }
      panel.insertAdjacentHTML('beforeend', `<div class="gs-ask">${icon('bot', 15)}<span>问 Ask AI：${esc(q)}</span></div>`);
      panel.querySelector('.gs-ask').onclick = () => { closePanel(); gs.value = ''; location.href = '/ask.html?q=' + encodeURIComponent(q); };
      panel.addEventListener('click', (e) => {
        const item = e.target.closest('.gs-item');
        if (item) go(results[Number(item.dataset.idx)]);
      });
      document.body.appendChild(panel);
    };
    const search = async (q) => {
      const enc = encodeURIComponent(q);
      const jobs = [
        api(`/api/communications?q=${enc}`).catch(() => []).then(rows => ({
          name: '沟通', kind: 'comm',
          items: (rows || []).slice(0, 3).map(c => ({ kind: 'comm', t: c.topic || ('沟通 #' + c.id), d: (c.created_at || '').slice(5, 10), href: '/communication.html?id=' + c.id })),
        })),
        api(`/api/customers?q=${enc}`).catch(() => []).then(rows => ({
          name: '客户', kind: 'cust',
          items: (rows || []).slice(0, 3).map(c => ({ kind: 'cust', t: c.name, d: c.owner || '', href: '/customers.html?q=' + encodeURIComponent(c.name) })),
        })),
      ];
      if (_shellMe && _shellMe.role !== 'sales') {
        jobs.push(api('/api/config/knowledge_base').catch(() => []).then(rows => ({
          name: '知识库', kind: 'kb',
          items: (rows || []).filter(x => (x.name + (x.data?.content || '')).includes(q)).slice(0, 2)
            .map(x => ({ kind: 'kb', t: x.name, d: '知识', href: '/config.html?domain=knowledge_base' })),
        })));
        jobs.push(api('/api/config/case_library').catch(() => []).then(rows => ({
          name: '案例库', kind: 'case',
          items: (rows || []).filter(x => (x.name + (x.data?.script || '')).includes(q)).slice(0, 2)
            .map(x => ({ kind: 'case', t: x.name, d: '案例', href: '/config.html?domain=case_library' })),
        })));
      }
      const groups = (await Promise.all(jobs)).map(g => ({ ...g, items: g.items.map(it => ({ ...it })) }));
      let idx = 0;
      for (const g of groups) for (const it of g.items) it.idx = idx++;
      render(groups, q);
    };
    gs.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = gs.value.trim();
      if (!q) { closePanel(); return; }
      debounce = setTimeout(() => search(q).catch(() => {}), 250);
    });
    gs.addEventListener('keydown', (e) => {
      const items = panel ? [...panel.querySelectorAll('.gs-item')] : [];
      if (e.key === 'Enter') {
        e.preventDefault();
        if (hlIdx >= 0 && results[hlIdx]) go(results[hlIdx]);
        else location.href = '/communications.html?q=' + encodeURIComponent(gs.value.trim());
      } else if (e.key === 'Escape') { closePanel(); gs.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        hlIdx = e.key === 'ArrowDown' ? (hlIdx + 1) % items.length : (hlIdx - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('hl', i === hlIdx));
        items[hlIdx].scrollIntoView({ block: 'nearest' });
      }
    });
    document.addEventListener('click', (e) => {
      if (panel && !panel.contains(e.target) && e.target !== gs) closePanel();
    });
  }
  // 账户菜单
  const avBtn = document.getElementById('av-btn');
  const accMenu = document.getElementById('acc-menu');
  avBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const show = !accMenu.classList.contains('show');
    accMenu.classList.toggle('show', show);
    avBtn.setAttribute('aria-expanded', String(show));
  });
  accMenu.addEventListener('click', (e) => e.stopPropagation());
}

/** 销售侧栏「今日待办」迷你摘要（M4：读 todos 表，失败静默） */
async function fillSideTodo() {
  try {
    const todos = await api('/api/todos?status=open');
    const n = document.getElementById('td-n'), rows = document.getElementById('td-rows');
    if (!n || !rows) return;
    n.textContent = todos.length;
    const today = new Date().toISOString().slice(0, 10);
    rows.innerHTML = todos.length
      ? todos.slice(0, 3).map(t => `<div class="r" onclick="location.href='/index.html'" title="${esc(t.what)}"><i class="${t.due && t.due < today ? 'hot' : ''}"></i><span>${esc(t.what)}</span></div>`).join('')
      : '<div class="r empty">今日暂无待办</div>';
  } catch {}
}

/** 拉取当前用户（401 跳登录） */
async function fetchMe() {
  try { return await api('/api/me'); } catch { return null; }
}

/**
 * 管理端壳：填充页面既有的 #top / #side 容器。
 * initShell('violations') / initShell('org') / initShell('emp') …
 */
async function initShell(active) {
  const me = await fetchMe();
  if (!me) { location.href = '/login.html'; return null; }
  _shellWS = 'admin'; _shellMe = me;
  localStorage.setItem('bc.admin.last', location.pathname + location.search);
  const top = document.getElementById('top');
  const side = document.getElementById('side');
  if (top) top.innerHTML = topbarHTML(me);
  if (side) side.innerHTML = sidebarHTML('admin', active, me);
  else document.body.insertAdjacentHTML('afterbegin', topbarHTML(me) + sidebarHTML('admin', active, me));
  wireShell();
  notifyBadge();
  return me;
}

/** 销售端壳：body 前置顶栏+侧栏，返回主容器（pages: mountAppShell('comm', me)） */
function mountAppShell(active, me) {
  // 兼容旧签名（传 name 字符串）：内部自行补拉 me
  _shellWS = 'sales';
  if (me && typeof me === 'string') {
    const main = mountAppShellShellOnly(active, null);
    fetchMe().then(m => { if (!m) { location.href = '/login.html'; return; } _shellMe = m; fillShellUser(m); fillSideTodo(); });
    return main;
  }
  _shellMe = me;
  const main = mountAppShellShellOnly(active, me);
  fillSideTodo();
  return main;
}
function mountAppShellShellOnly(active, me) {
  document.body.insertAdjacentHTML('afterbegin', topbarHTML(me) + sidebarHTML('sales', active, me));
  wireShell();
  const main = document.createElement('div');
  main.className = 'appmain';
  document.body.appendChild(main);
  notifyBadge();
  return main;
}
function fillShellUser(me) {
  const av = document.getElementById('av-btn');
  if (av) av.textContent = (me.name || '我')[0];
  const head = document.querySelector('#acc-menu .acc-head');
  if (head) head.innerHTML = `<b>${esc(me.name)}</b><span>${esc(me.role)}</span>`;
  // 权限补渲染：销售角色看不到管理后台选项
  if (me.role === 'sales') {
    const adminOpt = document.querySelector('.ws-opt[data-ws="admin"]');
    if (adminOpt) adminOpt.remove();
  }
  const nav = document.getElementById('nav-scroll');
  if (nav && _shellWS === 'sales') nav.innerHTML = navHTML('sales', nav.dataset.active || 'home', me);
}
/** 通知未读红点（失败静默） */
async function notifyBadge() {
  try {
    const d = await api('/api/notifications');
    const bell = document.getElementById('bell-btn');
    if (bell && d.unread > 0 && !bell.querySelector('.dot')) bell.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
  } catch {}
}
/** 管理端页内切换 domain 时移动激活态（不重建壳） */
function setActiveNav(key) {
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('on', a.dataset.key === key));
}

/* 站点图标（品牌蓝圆角方），消除 favicon 404 */
(function () {
  const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="9" fill="%233370FF"/></svg>'.replace('%233370FF', '#3370FF'));
  const l = document.createElement('link');
  l.rel = 'icon'; l.href = svg;
  document.head.appendChild(l);
})();
document.addEventListener('DOMContentLoaded', () => { if (!document.getElementById('toast')) { const t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); } });
