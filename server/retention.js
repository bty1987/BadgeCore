/**
 * 数据留存清理（07 册 CMP-08：到期自动删除并出删除证明）
 * ------------------------------------------------------
 * 默认（PRD 值）：音频 180 天 / 转写 3 年 / 报告 3 年；企业可在设置页调大，
 * 不得低于建议下限（MIN，PRD「不得低于纠纷取证建议期」）。
 * 处理：过期的音频删文件并清 audio_path；过期的转写/报告清空字段（保留记录壳
 * 供台账）；每次清理写审计（retention_purge）作为「删除证明」。
 * 触发：服务启动时 + 每 24 小时 + 设置页「立即清理」按钮。
 */
const fs = require('fs');
const { getSetting, audit } = require('./db');

const DEFAULTS = { audio_days: 180, transcript_days: 1095, report_days: 1095 };
const MIN = { audio_days: 180, transcript_days: 1095, report_days: 1095 }; // CMP-08 下限

/** 读取并按 MIN 钳制留存配置 */
function loadRetention(db) {
  const cfg = { ...DEFAULTS, ...(getSetting(db, 'retention') || {}) };
  for (const k of Object.keys(MIN)) cfg[k] = Math.max(MIN[k], Number(cfg[k]) || DEFAULTS[k]);
  return cfg;
}

/**
 * 执行一轮清理。
 * @returns {{audio:number, transcripts:number, reports:number, cfg:object}}
 */
function runRetentionPurge(db) {
  const cfg = loadRetention(db);
  const now = Date.now();
  const aged = days => new Date(now - days * 86400_000).toISOString();
  const out = { audio: 0, transcripts: 0, reports: 0, cfg };

  // 音频：删文件 + 清路径
  for (const row of db.prepare("SELECT id, audio_path FROM communications WHERE audio_path IS NOT NULL AND audio_path != ''").all()) {
    const comm = db.prepare('SELECT created_at FROM communications WHERE id=?').get(row.id);
    if (comm.created_at < aged(cfg.audio_days)) {
      try { fs.unlinkSync(row.audio_path); } catch { /* 文件已不在（挂载/手删）视为已清理 */ }
      db.prepare("UPDATE communications SET audio_path='' WHERE id=?").run(row.id);
      out.audio++;
    }
  }
  // 转写：清空字段
  const r1 = db.prepare('UPDATE communications SET transcript=? WHERE transcript != ? AND created_at < ?')
    .run('', '', aged(cfg.transcript_days));
  out.transcripts = r1.changes;
  // 报告：清空字段
  const r2 = db.prepare('UPDATE communications SET report=NULL WHERE report IS NOT NULL AND created_at < ?')
    .run(aged(cfg.report_days));
  out.reports = r2.changes;

  audit(db, 'system', 'retention_purge', '', JSON.stringify(out)); // 删除证明（CMP-08）
  return out;
}

module.exports = { runRetentionPurge, loadRetention, DEFAULTS, MIN };
