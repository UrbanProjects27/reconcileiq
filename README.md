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

Under **Settings → Manage users**, create each team member with a temporary password of at least 12 characters. Share it privately. They must choose a new password before accessing records. You can change roles, reset passwords and disable users. Changes revoke that user's existing sessions. Sessions expire after eight hours. Users can change their own password under Settings.

For forgotten passwords, choose **Forgot password?** on the sign-in page and submit the account email. The app gives the same response for existing and unknown accounts. Active-account requests appear under **Settings → Manage users → Password reset requests**. An administrator verifies the requester’s identity, then uses **Reset password → Create reset link** and shares the link privately. Links expire after 30 minutes, work once, and let the user choose a new password. Only token hashes are stored, and reset tokens use a URL fragment that is removed before network requests. Successful resets end the user's existing sessions. Creating a new link, changing the password, or changing account access invalidates older links.

Administrators can instead choose **Reset password → Set temporary password**. This signs the user out and requires a password change at the next sign-in. Use **Change password** for your own account; another administrator handles forgotten-password recovery. Reset requests and links are administrator managed: the app does not send reset emails automatically, and no email delivery provider is configured. Reset tokens and requests are private database records excluded from workspace backups and exports.

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

The backup restore imports ReconcileIQ JSON workspace backups. To import spreadsheet records, administrators can use Microsoft OneDrive → Browse files → Import on an `.xlsx` or `.csv` file. Select the worksheet, header row and data type, map columns, preview the changes, then confirm. Supported types are invoices, customer credit days, bank receipts, payment advice, sales returns, price returns and debit notes. Identical records are skipped; conflicting identifiers and invalid rows block the complete import. Existing customer credit days can be updated explicitly. Imports use revision checks, audit history and recovery snapshots. Files up to 100 MB are supported: all Excel workbooks and larger CSV files are streamed by a background worker into private staging tables, and the browser receives only a sample for mapping. Worksheets with Excel error cells or missing formula results are marked unavailable and excluded from staging; valid worksheets remain selectable. Resume preparation from Microsoft OneDrive → Bulk imports. Staged data is available for six hours and is removed after confirmation or cancellation. Each register supports up to 200,000 records; worksheets support 100 populated columns and workbooks up to 20 worksheets. The preview checks overall workspace capacity (64 MB of decoded data, with a 3,000 KB compressed storage envelope). The workspace and API payloads are compressed; register views display 100 records per page while balances and exports use all records. Large workspaces retain 20 recovery snapshots, smaller ones up to 100. Scheduled source synchronization is not enabled. See [ONEDRIVE-SETUP.md](ONEDRIVE-SETUP.md).

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

Sales files with one subtotal per brand can use **Separate brand amounts — combine by invoice** in import mapping. Map the Brand name column and the brand-specific amount column. The importer combines distinct brands under one invoice number and requires customer, date, customer code, order number and round off to agree. Repeated entries for the same brand are blocked. This option must not be used for repeated whole-invoice totals. The dashboard retains each brand amount and allocates invoice-level payments and adjustments proportionally. Preview and confirmation remain required.

Invoice reconciliation automatically clears a remaining balance from -10.00 through 10.00 rupees (inclusive), after payments, returns, deductions and manual round off. The automatic adjustment is calculated afresh from the source transactions, so later changes can reopen an invoice. The stored roundOff remains the manual adjustment; computed invoice views expose manualRoundOff, autoRoundOff, total roundOff and net pending. Registers, totals, filters and exports use these computed balances.

Reliability audit (3 November 2026): refresh responses cannot replace a newer revision; save authorization is rechecked inside the transaction; recovery accepts valid historical schemas; duplicate advice allocations are rejected; return/advice type parsing rejects inherited object properties; dates and cached ageing roll over at midnight; search keeps focus; advice filters and exports share the selected rows; bank queues paginate and matching uses indexes; ambiguous duplicate UTRs are excluded from advice entry; repeated save clicks and modal dismissal during financial saves are guarded; currency displays paise; CSV quoting and formula protection handle whitespace and carriage returns; custom status text is escaped; ageing exports use due dates; malformed server responses and revision inputs return useful errors. Existing transaction validation and snapshots remain in force.

Payment allocation is restricted to the bank receipt buyer (case-insensitive, ignoring outer whitespace). Select a uniquely identified, tagged bank receipt first; its buyer is read-only and filters invoice choices. New or edited advice and buyer retagging are checked on shared saves, and spreadsheet advice imports require a unique bank receipt with the same buyer. Automatic bank matching never changes the tagged buyer to match different-buyer advice. Historical allocations are preserved when unchanged and can be reviewed rather than silently reassigned.

Only administrators may delete financial entries. Delete controls are available in invoice, bank receipt, debit note, payment advice and returns registers, with a confirmation dialog. The server also rejects financial-record removals submitted by editors through whole-workspace saves. Deletion requires the reviewed workspace revision and exact record selection, records a record.deleted audit event, and stores the previous revision for recovery. Remove linked advice, returns and debit notes before deleting an invoice; remove linked advice before deleting a bank receipt. Removing Payment advice reopens its bank receipt for allocation.

EPC is a payment-advice deduction type alongside TDS, PPV, PQV, CCOGS and TaxD. Enter the actual bank cash as Payment and enter EPC separately: a 1,000-rupee invoice, 900-rupee cash Payment and 100-rupee EPC allocation reconcile to zero pending. EPC appears in invoice allocation details, adjustments, dashboard/customer deductions, brand-scoped views and reconciliation exports. Matched receipts may be used for deductions without reopening cash allocation. Debit notes remain audit records and are not added a second time to deductions already represented by advice.

Unallocated Transactions includes both unmatched bank receipts and Difference/review receipts, using the same rows in its export. Tagged receipts can open buyer-filtered payment allocation directly from that queue. Cash Payment may use unmatched or review receipts, while fully matched receipts remain unavailable for additional cash allocation. Resolve allocations, then run receipt matching; fully matched receipts leave the work queue.

Bank receipts support multiple same-buyer invoice allocations under one UTR. The shared finance.js calculation is loaded before auth.js and used by the server and browser. Allocated Payment is the sum of valid invoice-linked Payment rows for the receipt; Pending to Match is bank credit minus that total. Partial receipts show the remaining difference in the bank register, allocation picker, unallocated queue and exports. Status updates automatically after advice is saved or deleted. EPC, TDS and other deductions do not consume bank cash, and invoice round off never clears a bank difference. New cash allocations cannot exceed the remaining receipt balance; revision checks also protect concurrent allocation attempts. Duplicate references and mismatched buyers require review.

A Payment Advice entry can contain up to 100 invoice allocation rows for one UTR and buyer. Add/remove draft rows, search invoice/order/brand, set each row’s type, amount and description, then Save all allocations once. Rows share an internal advice ID; an invoice/type combination may appear once per entry, while Payment and EPC may be recorded separately for the same invoice. Live totals show the combined cash, deductions and remaining bank balance. All rows commit atomically, and failures retain the draft; a completed batch is recognized after a revision conflict to avoid reposting it.
