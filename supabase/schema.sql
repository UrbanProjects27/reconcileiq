CREATE SCHEMA IF NOT EXISTS reconcileiq;
REVOKE ALL ON SCHEMA reconcileiq FROM PUBLIC;

CREATE TABLE IF NOT EXISTS reconcileiq.app_users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
 password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 must_change INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconcileiq.app_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES reconcileiq.app_users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconcileiq.workspace (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.audit_events (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconcileiq.workspace_snapshots (revision INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON reconcileiq.app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_created ON reconcileiq.audit_events(created_at);

ALTER TABLE reconcileiq.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.app_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.workspace_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA reconcileiq FROM PUBLIC;

REVOKE ALL ON SCHEMA reconcileiq FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA reconcileiq FROM anon, authenticated;
