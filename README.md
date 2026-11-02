# ReconcileIQ

Shared invoice reconciliation workspace with email/password sign-in, Admin / Editor / Viewer roles, centralized storage, revision conflict protection, activity history and recoverable snapshots.

## Run locally

Requires Node.js 24.14 or later within the Node 24 release line.

```powershell
npm ci
npm run setup
npm start
```

Setup prompts for the first administrator's email, name and password. The password is hidden during entry. Open http://127.0.0.1:4173 and sign in. There are no default credentials or automatically loaded sample records.

Without `DATABASE_URL`, the server uses `data/reconcileiq.sqlite`. All signed-in users of this server share that database. The database and credentials must never be committed or uploaded as source files.

For an existing PostgreSQL database, set `DATABASE_URL` in the environment or in an ignored `.env` file before setup/start. `.env.example` shows the available settings. Production refuses to start without PostgreSQL; it cannot accidentally fall back to an ephemeral SQLite database.

## Team workflow

- Admins manage financial records, team access, audit history and backup restoration.
- Editors manage financial records and export operational reports.
- Viewers read records and export operational reports.
- All accounts belong to one shared Finance Desk workspace.

Under **Settings → Manage users**, create each team member with a temporary password of at least 12 characters. Share it privately. They must choose a new password before accessing records. You can change roles, reset passwords and disable users. Changes revoke that user's existing sessions. Sessions expire after eight hours. Users can change their own password under Settings; forgotten passwords are reset by an admin. Email invitations and self-service email reset are not configured.

Changes are acknowledged only after a successful database save. A stale revision is rejected instead of overwriting another user's changes. Form fields stay open for review and retry. Open pages check for updates every 30 seconds and when refocused, except while a modal is open. There is no offline editing mode.

## Reconciliation

- Pending = invoice value minus sales returns, price returns, payment advice allocations and signed round off. Bank credits are checked separately and never deducted twice.
- Customer Summary → Manage credit days sets terms for all invoices from that customer. New customers default to 45 days. Matching ignores case and surrounding whitespace.
- An unpaid invoice remains Due through its due date and becomes Overdue the next day. Dates use the browser's local calendar. Settled and excess-paid invoices are excluded from these two receivable categories; net pending still includes excess payments.
- Invoice entry requires no per-invoice credit days or material description.
- Record bank credits under Bank Reconciliation → Add bank receipt, then select the receipt's UTR in Payment Advice. Match transactions sums payment allocations for an exact receipt amount. Duplicate receipt references are kept for review and never auto-matched.
- Operational exports are Excel-compatible CSV files. Customer exports include credit days, Overdue and Due balances.

## Import existing browser data

Nothing is imported automatically.

1. On the original local address (usually http://127.0.0.1:4173), sign in as an admin.
2. Open **Settings → Import existing browser data → Download browser data**. This reads the old `reconcileiq-state` localStorage value without deleting it.
3. On the live site, use **Settings → Import / restore JSON** and choose that file.
4. Review the invoice, advice, receipt and customer counts, then choose **Replace shared records**.

Import replaces the shared financial records; it does not merge them. Users, passwords and sessions are excluded. Previous shared records are saved as a revision for recovery. Legacy invoice credit terms migrate to one mapping per customer, using the first invoice's valid terms, or 45 days when absent.

Only ReconcileIQ JSON workspace backups are supported by this import. Microsoft Graph OAuth, OneDrive sync, Excel/CSV file ingestion and scheduled source refresh are not implemented. The UI labels these as not configured.

## Backups and recovery

Admins can download a JSON workspace backup and review the latest 200 server-recorded events under Settings. The backup includes financial records, customer terms and up to 1,000 audit events; it excludes account credentials and sessions.

The server transactionally retains the previous 100 workspace revisions. **Settings → Previous revisions → Review restore** restores an earlier state as a new revision. These snapshots are in the same database and are not a substitute for independent database backups. Keep periodic JSON downloads off the hosting service and verify your provider's database backup/recovery settings. Database-level backups are needed to recover user accounts and the full audit history as well.

## Deploy on Netlify with Supabase

See [DEPLOY.md](DEPLOY.md). The frontend publishes only five allowlisted files from `dist/`. A Netlify Function adapts the existing Node API at `/api/*` and `/health`; Supabase PostgreSQL stores all shared records and accounts in the private `reconcileiq` schema. Password-based login remains the app's own server-side authentication system.

The schema enables RLS with no browser-access policies and revokes access from anonymous/authenticated Data API roles. Only the server's database connection accesses it. Supabase anon, publishable and service-role API keys are not required by the frontend. The expected advisor notice “RLS Enabled No Policy” means browser roles are denied by design for these private tables.

Use the Supabase transaction pooler for serverless connections, with a small pool and verified TLS using the bundled public Supabase root certificate. Set runtime secrets through Netlify's environment settings. `.netlify/`, generated output and local environment files are excluded from Git. The source repository no longer includes Render deployment configuration.

## Verification

```powershell
npm test
```

The suite checks calculations and failed-save retries plus HTTP integration tests on SQLite and an embedded PostgreSQL engine (PGlite). It verifies authentication, roles, CSRF/origin checks, validation, simultaneous saves, audit events, snapshots, password/session revocation and persistence. The PostgreSQL engine tests exercise PostgreSQL SQL semantics; hosted database connectivity, TLS and Netlify routing still need a post-deployment smoke test.

The public server serves only an explicit list of frontend files. Passwords use salted scrypt hashes, session tokens are hashed in storage, production cookies are Secure/HttpOnly/SameSite=Strict, and state changes require an authenticated role, CSRF token and allowed origin.
