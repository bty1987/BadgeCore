/**
 * BadgeCore 前端公共工具（零依赖）
 * api(): 带登录 Cookie 的 fetch 封装；toast(); confirmDlg(); 表格/表单渲染助手
 */
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
  if (!rows.length) { mount.innerHTML = `<div class="empty"><div class="icon">📋</div>暂无数据</div>`; return; }
  const head = columns.map(c => `<th style="${c.w ? 'width:' + c.w : ''}">${c.title}</th>`).join('') + (ops ? '<th class="ops">操作</th>' : '');
  const body = rows.map((r, i) => '<tr>' + columns.map(c => `<td>${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') +
    (ops ? `<td class="ops">${ops(r, i)}</td>` : '') + '</tr>').join('');
  mount.innerHTML = `<div style="overflow-x:auto"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
/** 管理后台侧边栏（对照截图菜单树） */
function adminSidebar(active, me) {
  const G = [
    ['沟通配置', [
      ['info_fields', '信息收集', '/config.html?domain=info_fields'],
      ['deal_models', '成交模型', '/config.html?domain=deal_models'],
      ['task_models', '任务模型', '/config.html?domain=task_models'],
      ['ability_models', '能力模型', '/config.html?domain=ability_models'],
      ['summary_templates', '沟通总结', '/config.html?domain=summary_templates'],
      ['analysis_dims', '沟通分析', '/config.html?domain=analysis_dims'],
      ['flows', '沟通流程', '/config.html?domain=flows'],
      ['violations', '违规检测', '/config.html?domain=violations'],
      ['competitors', '竞争对手', '/config.html?domain=competitors'],
    ]],
    ['沟通计划', [['plans', '字段设置', '/plans.html']]],
    ['客户管理', [
      ['cust_list', '客户列表', '/customers.html'],
      ['cust_fields', '字段设置', '/config.html?domain=info_fields'],
      ['cust_profile', '画像配置', '/config.html?domain=insight_categories'],
    ]],
    ['洞察配置', [['insight', '分类配置', '/config.html?domain=insight_categories']]],
    ['风险预警', [['risk', '风险预警', '/config.html?domain=risk_rules']]],
    ['知识库', [['knowledge', '知识库', '/config.html?domain=knowledge_base']]],
    ['案例库', [['cases', '案例库', '/config.html?domain=case_library']]],
    ['全局配置', [['global', '全局配置', '/settings.html']]],
    ['Ask AI', [['ask', 'Ask AI', '/ask.html']]],
    ['我的企业', [
      ['org', '组织架构', '/org.html'],
      ['employees', '员工名册', '/org.html?tab=emp'],
      ['roles', '角色权限', '/roles.html'],
    ]],
  ];
  return `<div class="sidebar">${G.map(([g, items]) => `
    <div class="group">${g}</div>
    ${items.map(([key, name, href]) => `<a class="item ${key === active ? 'active' : ''}" href="${href}">${name}</a>`).join('')}
  `).join('')}</div>`;
}
function adminTopbar(tab) {
  return `<div class="topbar">
    <div class="brand"><span class="logo"></span>管理后台</div>
    <div class="tabs"><a href="/index.html" class="${tab === 'app' ? 'active' : ''}">销售助手</a><a href="/settings.html" class="${tab === 'admin' ? 'active' : ''}">我的企业</a></div>
    <div class="right"><span id="_me"></span><div class="avatar" id="_av">管</div><a href="/api/logout" style="color:var(--text-2)">退出</a></div>
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
/** 销售端窄边栏（对照 01-coach-home 截图：首页/沟通/客户/案例库/看板 + 底部头像） */
function appSidebar(active, meName) {
  const N = [
    ['home', '🏠', '首页', '/index.html'],
    ['comm', '💬', '沟通', '/communications.html'],
    ['cust', '👥', '客户', '/customers.html'],
    ['cases', '📚', '案例库', '/cases.html'],
    ['dash', '📊', '看板', '/dashboard.html'],
  ];
  return `<div class="appbar">
    <div class="logo"></div>
    ${N.map(([k, ic, name, href]) => `<a class="nav ${k === active ? 'active' : ''}" href="${href}"><span class="ic">${ic}</span>${name}</a>`).join('')}
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
