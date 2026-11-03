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
CREATE TABLE IF NOT EXISTS reconcileiq.onedrive_connections (id INTEGER PRIMARY KEY, generation TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.onedrive_oauth (state_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.import_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES reconcileiq.app_users(id), file_id TEXT NOT NULL, status TEXT NOT NULL, info TEXT NOT NULL, error TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.import_chunks (job_id TEXT NOT NULL REFERENCES reconcileiq.import_jobs(id) ON DELETE CASCADE, sheet_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,sheet_key,chunk_index));
CREATE TABLE IF NOT EXISTS reconcileiq.password_reset_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES reconcileiq.app_users(id), requested_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reconcileiq.password_reset_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES reconcileiq.app_users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON reconcileiq.app_sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_created ON reconcileiq.audit_events(created_at);

ALTER TABLE reconcileiq.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.app_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.workspace_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.onedrive_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.onedrive_oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.import_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.password_reset_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconcileiq.password_reset_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA reconcileiq FROM PUBLIC;

REVOKE ALL ON SCHEMA reconcileiq FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA reconcileiq FROM anon, authenticated;
