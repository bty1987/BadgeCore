/**
 * 敏感信息脱敏（07 册 CMP-07：转写与报告中自动掩码，部分掩码显示）
 * -------------------------------------------------------------
 * 覆盖：手机号（1[3-9] 开头 11 位）、身份证（18 位含校验位 X）、银行卡（13~19 位数字串）。
 * 掩码策略（保留首尾便于人工辨认）：
 *   手机号  13812345678 → 138****5678
 *   身份证  110101199001011234 → 110***********1234
 *   银行卡  6222021234567890 → **** **** **** 7890
 * 应用位置（双层防御）：入库时对转写原文脱敏（LLM 永不接触明文，检索也命不中明文），
 * 分析输出层再过一遍（防 LLM 从配置/上下文回显）。
 * 局限（内部版可接受）：不处理分隔符写法（138-1234-5678 / 带空格卡号）。
 */
const PATTERNS = [
  { re: /(?<!\d)\d{17}[\dXx](?!\d)/g, mask: s => s.slice(0, 3) + '*'.repeat(11) + s.slice(14) }, // 身份证（先于银行卡，避免 18 位纯数字被当卡号）
  { re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, mask: s => s.slice(0, 3) + '****' + s.slice(7) },          // 手机号
  { re: /(?<!\d)\d{13,19}(?!\d)/g, mask: s => '**** **** **** ' + s.slice(-4) },                // 银行卡
];

function redactText(text) {
  let out = String(text ?? '');
  for (const { re, mask } of PATTERNS) out = out.replace(re, m => mask(m));
  return out;
}

/** 递归脱敏对象内所有字符串（报告输出层用；跳过 meta） */
function redactDeep(obj) {
  if (typeof obj === 'string') return redactText(obj);
  if (Array.isArray(obj)) return obj.map(redactDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = k === 'meta' ? v : redactDeep(v);
    return out;
  }
  return obj;
}

module.exports = { redactText, redactDeep };

// ---------- CLI 自测：node redact.js ----------
if (require.main === module) {
  const cases = [
    ['手机号 13812345678 收到', '手机号 138****5678 收到'],
    ['身份证 110101199001011234 一个', '身份证 110***********1234 一个'],
    ['银行卡 6222021234567890 转账', '银行卡 **** **** **** 7890 转账'],
    ['尾号X身份证 11010119900101123X', '尾号X身份证 110***********123X'],
    ['不误伤订单号 2026091100012345（16位）', null], // 银行卡规则会掩码长数字串——CMP-07 语义下宁可错杀
    ['短号 12345 不处理', '短号 12345 不处理'],
  ];
  let ok = true;
  for (const [input, expect] of cases) {
    const got = redactText(input);
    const pass = expect === null ? got !== input : got === expect;
    if (!pass) ok = false;
    console.log(pass ? '✓' : '✗', input, '→', got);
  }
  const report = { summary: '联系 13812345678', tasks: [{ evidence: '卡号 6222021234567890' }], meta: { model: 'mock' } };
  const r = redactDeep(report);
  const deepOk = r.summary.includes('138****5678') && r.tasks[0].evidence.includes('**** 7890') && r.meta.model === 'mock';
  console.log(deepOk ? '✓ 对象递归脱敏（meta 跳过）' : '✗ 递归脱敏失败');
  process.exit(ok && deepOk ? 0 : 1);
}
