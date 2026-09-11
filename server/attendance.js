/**
 * BadgeCore 考勤判定（05 册 ALL-201 服务端算法，BLE 信标无感打卡）
 * ---------------------------------------------------------------
 * 判定规则（05 册 §3，参数可配）：
 *   有效信号 = rssi ≥ threshold（默认 -75dBm）
 *   到达     = 60s 滑窗内出现 ≥2 个不同信标的有效信号（条件首次满足时刻）
 *   离开     = 连续 absenceMs（默认 5 分钟）无任何有效信号（离开时刻 = 最后有效信号 + absenceMs）
 * 输入 events: [{t: 毫秒时间戳, beacon: 信标ID, rssi}]，无序容错。
 *
 * 现阶段无蓝牙网关实物：BLE 网关/手机 App 上报接口见 index.js /api/attendance/judge，
 * 可用本模块 CLI 自测（node attendance.js）或前端「考勤」页粘贴模拟数据。
 */

const DEFAULTS = { rssiThreshold: -75, windowMs: 60_000, minBeacons: 2, absenceMs: 5 * 60_000 };

/**
 * @returns {{periods: [{inAt:number, outAt:number|null}], params: object}}
 */
function judgeAttendance(rawEvents, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const valid = rawEvents
    .filter(e => e && Number.isFinite(e.t) && e.beacon && Number.isFinite(e.rssi) && e.rssi >= p.rssiThreshold)
    .sort((a, b) => a.t - b.t);

  const periods = [];
  let inAt = null;            // 当前在场段的开始时刻
  let windowBeacons = new Map(); // windowStart 内 {beacon → lastT}

  for (let i = 0; i < valid.length; i++) {
    const e = valid[i];
    if (inAt === null) {
      // 维护 60s 滑窗，凑齐 ≥minBeacons 个不同信标即视为到达
      windowBeacons.set(e.beacon, e.t);
      for (const [b, t] of windowBeacons) if (e.t - t > p.windowMs) windowBeacons.delete(b);
      if (windowBeacons.size >= p.minBeacons) {
        inAt = e.t; // 条件满足时刻
        windowBeacons = new Map();
      }
    } else if (e.t - valid[i - 1].t > p.absenceMs) {
      // 上一段结束（断档超过 absenceMs），当前事件开新段候选
      periods.push({ inAt, outAt: valid[i - 1].t + p.absenceMs });
      inAt = null; i--; // 当前事件重新走到达判定
    }
  }
  if (inAt !== null) periods.push({ inAt, outAt: null });
  return { periods, params: p };
}

/** 判定结果 → 按天汇总成考勤记录（一天可能多段：取首段 in 为上班，末段 out 为下班） */
function periodsToDaily(periods) {
  const byDay = new Map();
  for (const { inAt, outAt } of periods) {
    const day = new Date(inAt).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { date: day, firstIn: inAt, lastOut: outAt, segments: 0 });
    const d = byDay.get(day);
    d.firstIn = Math.min(d.firstIn, inAt);
    d.lastOut = outAt === null ? d.lastOut : Math.max(d.lastOut ?? 0, outAt);
    d.segments++;
  }
  return [...byDay.values()];
}

module.exports = { judgeAttendance, periodsToDaily, DEFAULTS };

// ---------- CLI 自测：node attendance.js ----------
if (require.main === module) {
  const T0 = new Date('2026-09-11T01:00:00Z').getTime(); // 09:00 北京时间
  const ev = [];
  // 场景1：09:00 起两个信标交替（间隔30s）持续到 10:00，之后无信号 → 到达 09:01（凑齐第2个信标时）, 离开 10:05
  for (let t = 0; t < 3600_000; t += 30_000) ev.push({ t: T0 + t, beacon: `B${(t / 30_000) % 2}`, rssi: -60 });
  // 场景2：11:00 单信标持续 10 分钟（只 1 个信标，不应判到达）
  const T1 = new Date('2026-09-11T03:00:00Z').getTime();
  for (let t = 0; t < 600_000; t += 30_000) ev.push({ t: T1 + t, beacon: 'BX', rssi: -70 });
  // 场景3：13:00-13:30 两信标 → 第二段（与上段间隔>5min）
  const T2 = new Date('2026-09-11T05:00:00Z').getTime();
  for (let t = 0; t < 1800_000; t += 30_000) ev.push({ t: T2 + t, beacon: `B${(t / 30_000) % 2}`, rssi: -65 });

  const { periods } = judgeAttendance(ev);
  const fmt = t => t === null ? 'null' : new Date(t).toISOString().slice(11, 16);
  console.log('判定段:', periods.map(p => `${fmt(p.inAt)} → ${fmt(p.outAt)}`).join(' | '));
  console.log('按天汇总:', JSON.stringify(periodsToDaily(periods).map(d => ({
    date: d.date, in: fmt(d.firstIn), out: fmt(d.lastOut), segments: d.segments,
  }))));
  const ok =
    periods.length === 2 &&
    new Date(periods[0].inAt).getUTCHours() === 1 && new Date(periods[0].inAt).getUTCMinutes() === 0 &&  // 09:00:30 第2信标出现即到达
    periods[0].outAt !== null && new Date(periods[0].outAt).getUTCMinutes() === 4 &&                     // 最后信号 09:59:30 + 5min = 10:04
    periods[1].outAt === null;                                                                           // 当日末段在厂
  console.log(ok ? '\n自测通过：双段判定 / 单信标不判到达 / 断档分段 / 末段在厂' : '\n自测失败');
  process.exit(ok ? 0 : 1);
}
