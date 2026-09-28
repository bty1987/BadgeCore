/**
 * 企微集成适配器（10 册 W1 推送；D11 模拟惯例——env 未配置即降级站内信，凭据到位仅 env 变化）
 * env: WECOM_WEBHOOK_URL                S1 群机器人 webhook（推送，零凭据门槛）
 *      WECOM_CORPID/AGENTID/SECRET      S2 自建应用（应用消息；W2 扫码登录共用，齐备=app 模式）
 * 凭据仅存服务端 env，前端与数据库永不接触（10 册 §9）。
 */
const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';
let atCache = { token: '', expires: 0 };

/** 当前推送通道：off（未配置，仅站内信）| webhook（群机器人）| app（自建应用） */
function pushMode() {
  if (process.env.WECOM_CORPID && process.env.WECOM_AGENTID && process.env.WECOM_SECRET) return 'app';
  if (process.env.WECOM_WEBHOOK_URL) return 'webhook';
  return 'off';
}

/** S1：群机器人 markdown 消息（content 上限 4096 字节，此处再截一道） */
async function sendWebhook(markdown) {
  const r = await fetch(process.env.WECOM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: String(markdown).slice(0, 2000) } }),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.errcode === 0, errcode: d.errcode ?? `HTTP ${r.status}`, errMsg: d.errmsg || '' };
}

/** S2/W2 共用：应用 access_token（内存缓存 expires_in-300s，10 册 §4.1） */
async function accessToken() {
  if (atCache.token && atCache.expires > Date.now()) return atCache.token;
  const q = new URLSearchParams({ corpid: process.env.WECOM_CORPID, corpsecret: process.env.WECOM_SECRET });
  const r = await fetch(`${WECOM_API}/gettoken?${q}`, { signal: AbortSignal.timeout(10_000) });
  const d = await r.json().catch(() => ({}));
  if (d.errcode !== 0) throw new Error(`gettoken errcode=${d.errcode} ${d.errmsg || ''}`);
  atCache = { token: d.access_token, expires: Date.now() + (d.expires_in - 300) * 1000 };
  return atCache.token;
}

/** S2：应用消息推个人（touser=企微 userid，来源 users.wecom_userid） */
async function sendAppMessage(touser, markdown) {
  const token = await accessToken();
  const r = await fetch(`${WECOM_API}/message/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser, msgtype: 'markdown', agentid: Number(process.env.WECOM_AGENTID),
      markdown: { content: String(markdown).slice(0, 2000) },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: d.errcode === 0, errcode: d.errcode ?? `HTTP ${r.status}`, errMsg: d.errmsg || '' };
}

/** W2 扫码登录预留：授权 code 换成员 userid（simulated 分支在调用方：code='mock' → 'wecom-demo'） */
async function useridByCode(code) {
  const token = await accessToken();
  const r = await fetch(`${WECOM_API}/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json().catch(() => ({}));
  if (d.errcode !== 0) throw new Error(`getuserinfo errcode=${d.errcode} ${d.errmsg || ''}`);
  return d.userid;
}

module.exports = { pushMode, sendWebhook, sendAppMessage, accessToken, useridByCode };
