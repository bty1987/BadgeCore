#!/usr/bin/env node
/**
 * 生产库备份独立入口（手动/cron）：node scripts/db-backup.js [--db <库文件路径>]
 * 默认备份 server/data/badgecore.db → server/data/backups/，保留 30 份滚动（KEEP 见 server/backup.js）。
 * cron 示例：0 3 * * * cd <项目根> && node scripts/db-backup.js >> server/data/backup.log 2>&1
 */
const path = require('path');
const { backupNow } = require('../server/backup');

const dbFile = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : (process.env.DB_FILE || path.join(__dirname, '..', 'server', 'data', 'badgecore.db'));

try {
  const r = backupNow(dbFile);
  console.log(`done ${r.file}`);
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
