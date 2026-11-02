const fs = require('node:fs');
const path = require('node:path');
const { emptyState } = require('./state');
const schema = `
CREATE TABLE IF NOT EXISTS app_users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
 password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_snapshots (revision INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_created ON audit_events(created_at);
`;
const tableNames = ['app_users','app_sessions','workspace','audit_events','workspace_snapshots','login_attempts'];
function qualifySql(sql, namespace = '') {
  if (!namespace) return sql;
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error('Invalid database schema.');
  const tables = tableNames.join('|');
  return sql.replace(new RegExp(`\\b(TABLE IF NOT EXISTS|FROM|JOIN|INTO|UPDATE|REFERENCES|ON)\\s+(${tables})(?![\\w.])`, 'gi'), `$1 ${namespace}.$2`);
}
function postgresSchema(namespace = 'reconcileiq') {
  return `CREATE SCHEMA IF NOT EXISTS ${namespace};\nREVOKE ALL ON SCHEMA ${namespace} FROM PUBLIC;\n` + qualifySql(schema, namespace) + '\n' +
    tableNames.map(table => `ALTER TABLE ${namespace}.${table} ENABLE ROW LEVEL SECURITY;`).join('\n') +
    `\nREVOKE ALL ON ALL TABLES IN SCHEMA ${namespace} FROM PUBLIC;\n`;
}
async function openDatabase(options = {}) {
  const url = options.url === undefined ? process.env.DATABASE_URL : options.url;
  if (url) {
    const { Pool } = require('pg');
    const namespace = options.namespace === undefined ? process.env.DATABASE_SCHEMA || '' : options.namespace;
    const compile = sql => qualifySql(sql, namespace);
    const ca = process.env.DATABASE_SSL_CA;
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX || 2),
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, allowExitOnIdle: true,
      ...(process.env.DATABASE_SSL === 'true' ? {ssl: {rejectUnauthorized: true, ...(ca ? {ca} : {})}} : {}),
    });
    pool.on('error', error => console.error('Database pool error:', error.message));
    const query = async (sql, params = []) => (await pool.query(compile(sql), params)).rows;
    if (process.env.DATABASE_SCHEMA_READY !== 'true') await pool.query(namespace ? postgresSchema(namespace) : schema);
    const db = {
      kind: 'postgres', query,
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(async (sql, params = []) => (await client.query(compile(sql), params)).rows);
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
    await initialize(db); return db;
  }
  if (process.env.NODE_ENV === 'production' && !options.filename) throw new Error('DATABASE_URL is required in production.');
  const { DatabaseSync } = require('node:sqlite');
  const filename = options.filename || process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'reconcileiq.sqlite');
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqlite.exec(schema);
  const query = async (sql, params = []) => sqlite.prepare(sql.replace(/\$\d+/g, '?')).all(...params);
  // Do not let another request join this connection's active transaction.
  let queue = Promise.resolve();
  const enqueue = fn => { const job = queue.then(fn); queue = job.catch(() => {}); return job; };
  const db = {
    kind: 'sqlite', query: (sql, params) => enqueue(() => query(sql, params)),
    transaction: fn => enqueue(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = await fn(query); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }),
    close: () => enqueue(() => sqlite.close()),
  };
  await initialize(db); return db;
}
async function initialize(db) {
  await db.query('INSERT INTO workspace(id,revision,data) VALUES(1,0,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(emptyState())]);
  await db.query('DELETE FROM app_sessions WHERE expires_at < $1', [new Date().toISOString()]);
}
module.exports = { openDatabase, schema, initialize, qualifySql, postgresSchema };
