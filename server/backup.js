/**
 * 生产库每日备份：VACUUM INTO 一致性快照（在线安全，不阻塞服务写入），保留 30 份滚动。
 * 双入口：①服务内调度器每日 03:20 自动跑（startScheduler 接线）②scripts/db-backup.js 独立手动/cron 跑。
 * 快照只读源库（VACUUM INTO 把数据复制到目标文件，源库不加写锁）。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 30;
const ts = () => new Date().toISOString();

/** 跑一次备份：返回 { file, size, removed }；失败抛异常（调用方决定是否吞掉） */
function backupNow(dbFile, backupDir) {
  const dir = backupDir || path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const target = path.join(dir, `badgecore-${stamp}.db`);
  const db = new DatabaseSync(dbFile); // 只执行 VACUUM INTO（读源库），不碰 schema
  try { db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`); } finally { db.close(); }
  const size = fs.statSync(target).size;
  // 滚动清理 KEEP 之外最旧的快照
  const files = fs.readdirSync(dir).filter(f => /^badgecore-\d{4}-\d{2}-\d{2}T?[-\d]*\.db$/.test(f)).sort();
  const removed = [];
  while (files.length > KEEP) {
    const f = files.shift();
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch { /* 文件被占用，下轮再清 */ }
  }
  console.log(`[${ts()}] [备份] 快照完成 ${target} ${size}B${removed.length ? `，滚动清理 ${removed.length} 份` : ''}`);
  return { file: target, size, removed: removed.length };
}

module.exports = { backupNow, KEEP };
