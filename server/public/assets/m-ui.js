/**
 * 移动端 H5 壳（public/m/；依赖 app.js 全局 api/esc/icon；会话=同源 badge_token cookie）
 * ---------------------------------------------------------------
 * initMShell(active, title, opts?) → { page, me, rightSlot } | null（未登录已跳登录页）
 *   active: 'home' | 'comms' | 'meetings' | 'me'（底部 Tab 高亮）
 *   opts.back   返回链接（二级页用，如 /m/comms.html）
 *   opts.right  右上角自定义 HTML（按钮/图标）
 * 页面容器：返回对象的 page（.m-page），业务代码向其渲染。
 */
const M_TABS = [
  { key: 'home', label: '首页', icon: 'home', href: '/m/index.html' },
  { key: 'comms', label: '沟通', icon: 'mic', href: '/m/comms.html' },
  { key: 'meetings', label: '会议', icon: 'calendar', href: '/m/meetings.html' },
  { key: 'me', label: '我的', icon: 'user', href: '/m/me.html' },
];

async function initMShell(active, title, opts = {}) {
  const me = await fetch('/api/me', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!me) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); // 同源登录页，登录后回原页
    return null;
  }
  document.body.classList.add('m-body');
  const root = document.getElementById('m-root') || (() => {
    const d = document.createElement('div'); d.id = 'm-root'; document.body.appendChild(d); return d;
  })();
  const tabs = M_TABS.map(t =>
    `<a class="m-tab ${t.key === active ? 'active' : ''}" href="${t.href}">${icon(t.icon, 20)}<span>${t.label}</span></a>`).join('');
  root.innerHTML = `
    <header class="m-topbar">
      ${opts.back ? `<a class="m-back" href="${opts.back}">${icon('x', 18)}</a>` : '<span class="m-topbar-side"></span>'}
      <b class="m-title">${esc(title)}</b>
      <span class="m-topbar-side m-right" id="m-topbar-right">${opts.right || ''}</span>
    </header>
    <main class="m-page" id="m-page"></main>
    <nav class="m-tabbar">${tabs}</nav>`;
  return {
    page: document.getElementById('m-page'),
    me,
    rightSlot: document.getElementById('m-topbar-right'),
  };
}

/** 移动端底部表单抽屉（新建/编辑共用）：onSave(bodyEl) 返回 Promise，成功后自动关闭；失败 toast 并保留表单 */
window.mSheet = function ({ title, bodyHtml, onSave, saveLabel = '保 存' }) {
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:300;display:flex;align-items:flex-end';
  mask.innerHTML = `<div style="background:var(--card);width:100%;border-radius:16px 16px 0 0;max-height:88vh;overflow-y:auto;padding:14px 16px calc(14px + env(safe-area-inset-bottom))">
    <div style="display:flex;align-items:center;margin-bottom:4px"><b style="font-size:15px">${esc(title)}</b><span style="flex:1"></span><a id="_ms-x" style="color:var(--text-3);font-size:20px;padding:2px 8px;cursor:pointer">×</a></div>
    <div id="_ms-body">${bodyHtml}</div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button id="_ms-cancel" style="flex:1;border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:10px;padding:10px;font-size:14px;cursor:pointer">取 消</button>
      <button id="_ms-save" style="flex:2;border:0;background:var(--primary);color:#fff;border-radius:10px;padding:10px;font-size:14px;cursor:pointer">${esc(saveLabel)}</button>
    </div></div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector('#_ms-x').onclick = close;
  mask.querySelector('#_ms-cancel').onclick = close;
  mask.querySelector('#_ms-save').onclick = async () => {
    const btn = mask.querySelector('#_ms-save');
    if (btn._saving) return; btn._saving = true; // 防重复提交
    btn.textContent = '保存中…';
    try {
      await onSave(mask.querySelector('#_ms-body'));
      close();
    } catch (e) { /* 失败保留表单（错误已由 api() toast） */ }
    btn.textContent = saveLabel; btn._saving = false;
  };
  return { close };
};

/** 登录页 next 参数回跳：登录成功后 location.href 携带 ?next= 时优先回原页（login.html 调用） */
window.mNextAfterLogin = function () {
  const next = new URLSearchParams(location.search).get('next');
  if (next && next.startsWith('/m/') && !next.includes('//')) location.href = next;
};
