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
  dept_id INTEGER,                           -- 所属部门（组织架构，ADM-301）
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS depts(            -- 部门树（ADM-301，parent_id 成树）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  leader TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customers(        -- 客户管理（04 册 §2 / 08 册销售端客户列表）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  profile TEXT DEFAULT '{}',                 -- 画像自定义字段（JSON，企业自行约定）
  owner TEXT DEFAULT '',                     -- 负责销售
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  last_comm_at TEXT                          -- 最近沟通时间（沉默预警用，ALL/风险预警）
);
CREATE TABLE IF NOT EXISTS plans(            -- 沟通计划（REC-02 安排沟通）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  customer_id INTEGER,
  owner TEXT DEFAULT '',
  plan_at TEXT,                              -- 计划时间
  flow TEXT DEFAULT '',                      -- 关联沟通流程名
  info_fields TEXT DEFAULT '{}',             -- 需采集的信息收集字段值
  status TEXT DEFAULT 'planned',             -- planned | done
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(          -- 设备台账（04 册设备管理域，ADM 联动 05 册）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_key TEXT UNIQUE NOT NULL,           -- 设备标识（接收端上报，如 xiaozhi-1.75c:<device-id>）
  model TEXT DEFAULT '',
  fw_version TEXT DEFAULT '',
  owner TEXT DEFAULT '',                     -- 持有人
  battery TEXT DEFAULT '',
  status TEXT DEFAULT 'offline',             -- online | offline
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_logs(      -- 设备操作日志（对标 ★ badge operation-log）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_key TEXT NOT NULL,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,                      -- bind | unbind | session | offline
  detail TEXT DEFAULT ''
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
  customer_id INTEGER,                        -- 关联客户（先分析后关联 ADM-212）
  plan_id INTEGER,                            -- 关联沟通计划（REC-02）
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
CREATE TABLE IF NOT EXISTS attendance_records(  -- 05 册 ALL-201/202，与沟通数据分域（CMP-09）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  date TEXT NOT NULL,                          -- YYYY-MM-DD
  first_in TEXT, last_out TEXT,                -- ISO 时间
  status TEXT NOT NULL DEFAULT 'auto',         -- auto | manual | abnormal
  source TEXT NOT NULL DEFAULT 'beacon',       -- beacon | manual
  note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS team_reports(         -- 团队报告（对标 team_report 周报/月报/季报/年报）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,                          -- weekly | monthly
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  content TEXT NOT NULL,                         -- JSON（统计+AI 总结）
  created_at TEXT NOT NULL,
  created_by TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notifications(        -- 站内信（AI-11 定时报告推送的投递箱）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS todos(                -- 待办/行动项（ANA-10 提取 + M4 状态流转）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comm_id INTEGER NOT NULL,
  todo_key TEXT NOT NULL,                        -- comm 内稳定键（what 归一化 hash），改标重析后状态延续
  kind TEXT NOT NULL DEFAULT 'todo',             -- todo（销售/培训承诺提取）| action（会议行动项）
  what TEXT NOT NULL,
  owner TEXT DEFAULT '',                         -- 负责人（行动项显式指定，其余=沟通归属人）
  due TEXT,                                      -- 截止（YYYY-MM-DD 或空；模糊日期不参与到期提醒）
  status TEXT NOT NULL DEFAULT 'open',           -- open | done
  created_at TEXT NOT NULL,
  done_at TEXT,
  notified_on TEXT                               -- 到期提醒去重（当日已提醒）
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todo_key ON todos(comm_id, todo_key);
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
  // 旧库迁移：新增列（已存在则忽略）
  for (const [table, col, type] of [
    ['communications', 'customer_id', 'INTEGER'],
    ['communications', 'plan_id', 'INTEGER'],
    ['customers', 'silence_notified_at', 'TEXT'],
    // 09 册内部组织场景（INT-10/40/12）：场景标签 + 谈话参与者（逗分隔）+ 设备默认场景
    ['communications', 'scene', "TEXT DEFAULT 'sales'"],
    ['communications', 'participants', 'TEXT DEFAULT \'\''],
    ['devices', 'default_scene', "TEXT DEFAULT 'sales'"],
    // 10 册 W1/W2 企微集成：成员企微 userid（扫码登录自动写入，S2 应用消息 touser）
    ['users', 'wecom_userid', 'TEXT'],
    // 沟通计划主动提醒（M4）：当日已提醒去重
    ['plans', 'reminded_on', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* 列已存在 */ }
  }
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
