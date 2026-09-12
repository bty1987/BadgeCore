/**
 * BadgeCore 前端公共工具（零依赖）
 * icon(): 内联线性 SVG 图标系统；api(); toast(); dlg(); 表格/表单渲染助手
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
  chev: '<path d="M9 6l6 6-6 6"/>',
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
/** 弹窗：dlg.open({title, body(html), foot([{label,cls,onClick}])})；返回 close 函数 */
function dlg() {
  const mask = document.createElement('div');
  mask.className = 'mask';
  document.body.appendChild(mask);
  const api = {
    close() { mask.remove(); },
  };
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
/** 通用 CRUD 表格页渲染：mountCrud({mountEl, title, items, columns, onNew, onEdit, onDelete, tabs}) */
function renderTable(mount, columns, rows, ops) {
  if (!rows.length) {
    mount.innerHTML = `<div class="empty"><div class="empty-badge">${icon('inbox', 30)}</div>暂无数据</div>`;
    return;
  }
  const head = columns.map(c => `<th style="${c.w ? 'width:' + c.w : ''}">${c.title}</th>`).join('') + (ops ? '<th class="ops">操作</th>' : '');
  const body = rows.map((r, i) => '<tr>' + columns.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') +
    (ops ? `<td class="ops">${ops(r, i)}</td>` : '') + '</tr>').join('');
  mount.innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
/** 管理后台侧边栏（对照截图菜单树，线性图标版） */
function adminSidebar(active, me) {
  const G = [
    ['沟通配置', 'sliders', [
      ['info_fields', '信息收集', 'file-text', '/config.html?domain=info_fields'],
      ['deal_models', '成交模型', 'target', '/config.html?domain=deal_models'],
      ['task_models', '任务模型', 'list-check', '/config.html?domain=task_models'],
      ['ability_models', '能力模型', 'gauge', '/config.html?domain=ability_models'],
      ['summary_templates', '沟通总结', 'message', '/config.html?domain=summary_templates'],
      ['analysis_dims', '沟通分析', 'sliders', '/config.html?domain=analysis_dims'],
      ['flows', '沟通流程', 'route', '/config.html?domain=flows'],
      ['violations', '违规检测', 'octagon', '/config.html?domain=violations'],
      ['competitors', '竞争对手', 'flag', '/config.html?domain=competitors'],
    ]],
    ['沟通计划', 'calendar', [['plans', '字段设置', 'calendar', '/config.html?domain=info_fields&group=plans']]],
    ['客户管理', 'users', [
      ['cust_list', '客户列表', 'users', '/customers.html'],
      ['cust_fields', '字段设置', 'file-text', '/config.html?domain=info_fields'],
      ['cust_profile', '画像配置', 'layers', '/config.html?domain=insight_categories'],
    ]],
    ['洞察配置', 'sparkles', [['insight', '分类配置', 'sparkles', '/config.html?domain=insight_categories']]],
    ['风险预警', 'alert', [['risk', '风险预警', 'alert', '/config.html?domain=risk_rules']]],
    ['知识库', 'database', [['knowledge', '知识库', 'database', '/config.html?domain=knowledge_base']]],
    ['案例库', 'trophy', [['cases', '案例库', 'trophy', '/config.html?domain=case_library']]],
    ['全局配置', 'gear', [['global', '全局配置', 'gear', '/settings.html']]],
    ['Ask AI', 'bot', [['ask', 'Ask AI', 'bot', '/ask.html']]],
    ['我的企业', 'building', [
      ['org', '组织架构', 'building', '/org.html'],
      ['employees', '员工名册', 'user', '/org.html?tab=emp'],
      ['roles', '角色权限', 'shield', '/roles.html'],
    ]],
  ];
  return `<div class="sidebar">${G.map(([g, gIcon, items]) => `
    <div class="group">${icon(gIcon, 14)}${g}</div>
    ${items.map(([key, name, ic, href]) => `<a class="item ${key === active ? 'active' : ''}" href="${href}">${icon(ic, 15)}<span>${name}</span></a>`).join('')}
  `).join('')}</div>`;
}
function adminTopbar(tab) {
  return `<div class="topbar">
    <div class="brand"><span class="logo"></span>管理后台</div>
    <div class="tabs"><a href="/index.html" class="${tab === 'app' ? 'active' : ''}">销售助手</a><a href="/settings.html" class="${tab === 'admin' ? 'active' : ''}">我的企业</a></div>
    <div class="right"><span id="_me"></span><div class="avatar" id="_av">管</div><a href="/api/logout" style="color:var(--text-2);display:flex;align-items:center;gap:4px">${icon('logout', 14)}退出</a></div>
  </div>`;
}
/** 拉取当前用户并填充顶栏 */
async function loadMe() {
  try {
    const me = await api('/api/me');
    const el = document.getElementById('_me');
    if (el) el.textContent = me.name;
    const av = document.getElementById('_av');
    if (av) av.textContent = (me.name || '管')[0];
    return me;
  } catch { return null; }
}
/** 销售端窄边栏（对照 01-coach-home 截图：线性图标版） */
function appSidebar(active, meName) {
  const N = [
    ['home', 'home', '首页', '/index.html'],
    ['comm', 'mic', '沟通', '/communications.html'],
    ['cust', 'users', '客户', '/customers.html'],
    ['cases', 'trophy', '案例库', '/cases.html'],
    ['dash', 'chart', '看板', '/dashboard.html'],
  ];
  return `<div class="appbar">
    <div class="logo"></div>
    ${N.map(([k, ic, name, href]) => `<a class="nav ${k === active ? 'active' : ''}" href="${href}">${icon(ic, 19)}<span>${name}</span></a>`).join('')}
    <div class="me" title="${esc(meName || '')}" onclick="location.href='/settings.html'">${esc((meName || '我')[0])}</div>
  </div>`;
}
/** 销售端页面骨架挂载：document.body 前置 appbar，返回主容器 */
function mountAppShell(active, meName) {
  document.body.insertAdjacentHTML('afterbegin', appSidebar(active, meName));
  const main = document.createElement('div');
  main.className = 'appmain';
  document.body.appendChild(main);
  return main;
}
document.addEventListener('DOMContentLoaded', () => { if (!document.getElementById('toast')) { const t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); } });
