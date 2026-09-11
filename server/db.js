/**
 * BadgeCore 后台数据层（node:sqlite，零外部依赖，D13）
 * 库文件默认 server/data/badgecore.db（已 gitignore，含转写与报告数据）
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales',        -- admin | manager | sales
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  duration_s REAL DEFAULT 0,
  audio_path TEXT,
  transcript TEXT DEFAULT '',
  report TEXT,                                -- JSON（analysis.js 输出）
  status TEXT NOT NULL DEFAULT 'recorded',    -- recorded | transcribed | analyzed | failed
  owner TEXT DEFAULT '',
  topic TEXT DEFAULT '',
  meta TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS config_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,                       -- 九大域之一（04 册 ADM-01x）
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  data TEXT DEFAULT '{}',                     -- JSON（各域自定义结构）
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT DEFAULT '',
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_comm_created ON communications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_domain ON config_items(domain);
`;

function openDb(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

/** settings 读写（值为 JSON） */
function getSetting(db, key, dflt = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : dflt;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function audit(db, user, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit(ts, user, action, target, detail) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), user, action, target, String(detail).slice(0, 500));
}

module.exports = { openDb, getSetting, setSetting, audit };
