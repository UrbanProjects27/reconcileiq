# Deploy ReconcileIQ on Netlify + Supabase

The source is in https://github.com/UrbanProjects27/reconcileiq. Netlify hosts the frontend and API; Supabase PostgreSQL stores financial records, accounts, sessions and audit history. The app retains its existing email/password authentication and role controls. It does not use Supabase Auth or expose Supabase database API keys to browsers.

## Current resources

- Netlify site: https://reconcileiq-urbanretail.netlify.app
- Netlify project: https://app.netlify.com/projects/reconcileiq-urbanretail
- Supabase project: https://supabase.com/dashboard/project/rbilbxgdmafejstuzbzo
- Supabase organization: Urban Retail Projects
- Database schema: `reconcileiq`

Render is not part of this deployment. Its previous resources are not used by the application.

## Database setup

The schema is defined in `supabase/schema.sql`. It has been applied to the ReconcileIQ project. All six tables have RLS enabled. Anonymous and authenticated Data API roles cannot access this private schema. No permissive browser policies are needed because only the server's database connection reads and writes it.

For another Supabase project, review existing tables before applying that SQL through the SQL editor or your migration tooling. Use a new, dedicated project when possible.

## Netlify configuration

`netlify.toml` publishes `dist/` and bundles `netlify/functions/api.mjs`. `npm run build` copies only `index.html`, `app.js`, `auth.js`, `styles.css` and `overrides.css` into the published directory. The backend source, SQL, credentials, database files and project tools remain outside it.

The modern Fetch function adapts the existing HTTP API at `/api/*` and `/health`. It caches application initialization per warm instance, keeps the PostgreSQL connection pool small and checks the canonical app origin on writes. No long-running Node process or public backend port is required.

Set these environment variables in Netlify through its UI, CLI or API. Runtime variables cannot be supplied by `netlify.toml`.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `AWS_LAMBDA_JS_RUNTIME` | `nodejs24.x` |
| `APP_ORIGIN` | `https://reconcileiq-urbanretail.netlify.app` |
| `DATABASE_URL` | Supabase transaction pooler URI, with the real database password |
| `DATABASE_SCHEMA` | `reconcileiq` |
| `DATABASE_SCHEMA_READY` | `true` |
| `DATABASE_POOL_MAX` | `2` |
| `DATABASE_SSL` | `true` |
| `ADMIN_EMAIL` | Initial administrator's email |
| `ADMIN_NAME` | Initial administrator's name |
| `ADMIN_PASSWORD` | Initial temporary password; remove after bootstrap and redeploy |

Mark `DATABASE_URL` and `ADMIN_PASSWORD` as secrets in the Production context, with Functions scope. Use other scopes only if needed for provider/tooling limitations. Keep all secret values out of Git and chat.

### Obtain the database connection URI

1. Open the Supabase project and choose **Connect → Transaction pooler**.
2. Copy the URI (port `6543`) and replace the password placeholder with the database password. URL-encode password punctuation where required.
3. If the database password is unknown, set it through the project's Database Settings page.
4. Set the completed URI as `DATABASE_URL` in Netlify's environment settings.

The transaction pooler supports serverless clients over IPv4. The `pg` driver uses parameterized queries without named prepared statements. TLS certificate verification stays enabled. If Supabase requires its project root certificate, set `DATABASE_SSL_CA` using the certificate from Supabase Database Settings. Do not disable certificate verification.

Supabase reference: https://supabase.com/docs/guides/database/connecting-to-postgres

## Build and deploy

```powershell
npm ci
npm test
npm run build
npx netlify build --offline
npx netlify deploy --prod --build
```

The local `.netlify/state.json` links this directory to its site and is ignored by Git. This site was created for CLI deployment; it is not automatically linked to Git continuous deployment. Pushes update GitHub source but do not publish the app until Git continuous deployment is connected in Netlify or another CLI deploy runs.

Netlify references:
- https://docs.netlify.com/build/functions/configuration/
- https://docs.netlify.com/build/environment-variables/overview/

## First sign-in and verification

1. `/health` should return `{"ok":true}` and an anonymous `/api/session` request should return `401`.
2. Sign in with the initial administrator email and temporary password. You must choose a new password before opening financial records.
3. A new workspace starts empty. No browser data or sample invoices are imported automatically.
4. Create team accounts under Settings. New team members must also change their temporary passwords.
5. Test an Editor and a Viewer in separate browser sessions. Both should see the same data; the Viewer cannot save.
6. Confirm simultaneous edits reject a stale save while preserving form input for review and retry.
7. Download a JSON backup and test recovery through Previous revisions with a disposable record.
8. Import your existing browser data using the workflow in README.md.

JSON imports are limited to 4 MB for compatibility with serverless payload limits. The app retains 100 previous revisions in Supabase; these are not independent disaster-recovery backups. Keep regular JSON downloads and review Supabase's backup settings for the project's plan.

## Troubleshooting

- **Database not configured / 503:** check `DATABASE_URL` in the Production context and redeploy after saving it. Also confirm the Supabase project is active.
- **Password authentication failed:** verify the database password in the URI and its URL encoding. This is separate from an app user's password.
- **Certificate error:** obtain the project's CA certificate and configure `DATABASE_SSL_CA`; keep TLS verification enabled.
- **Origin is not allowed:** `APP_ORIGIN` must exactly match the HTTPS hostname used by the browser. If adding a custom domain, update that variable and redeploy.
- **No workspace tables:** apply `supabase/schema.sql` and verify the private schema before setting `DATABASE_SCHEMA_READY=true`.
- **RLS Enabled No Policy advisor notices:** expected for private, server-only tables. Do not add broad public policies to silence these informational notices.
- **Netlify connector needs reauthentication:** the CLI can use `netlify login --request` followed by the user-authorized `--check` flow.
