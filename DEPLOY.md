# First deployment: GitHub + Render

The application is prepared locally. The repository and Render connection are configured for a free trial. The web service and database can also be provisioned directly through the connected Render integration; render.yaml describes the matching configuration for future Blueprint deployments.

## 1. Create your accounts

1. Create or sign in to your [GitHub account](https://github.com/signup).
2. Create or sign in to your [Render account](https://dashboard.render.com/register). Using GitHub sign-in makes connecting the repository straightforward.

Keep passwords, verification codes and hosting secrets in the provider's own forms. Do not add them to repository files or chat.

## 2. Put the source in a private GitHub repository

Create a private repository named `reconcileiq`. Upload the contents of the source package, retaining the `lib` and `scripts` folders. `render.yaml`, `package.json` and `package-lock.json` must be in the repository root.

Include:

- `index.html`, `app.js`, `auth.js`, `styles.css`, `overrides.css`, `server.js`
- `lib/`, `scripts/`
- `package.json`, `package-lock.json`, `render.yaml`, `.gitignore`, `.env.example`
- `README.md`, `DEPLOY.md`, `reconciliation.test.js`, `server.test.js`

Do not upload `data/`, `.env`, `node_modules/`, local backups or test output. The release ZIP contains source files only; extract it before uploading the folder contents to GitHub.

## 3. Create the Render Blueprint

1. In Render choose **New → Blueprint**, connect GitHub and select the private `reconcileiq` repository. Grant repository access only as needed.
2. Render reads `render.yaml` and shows the web service and database it will create. Review the resource names and region; both resources should use the Free plan. Change names if they conflict with existing resources.
3. Enter the prompted values:
   - `ADMIN_EMAIL`: your administrator email.
   - `ADMIN_NAME`: your display name.
   - `ADMIN_PASSWORD`: a unique 12–128 character password.
4. Create the Blueprint after confirming both resources are Free and wait for the web service health check to pass.

The Blueprint connects `DATABASE_URL` using the database's internal connection string. Database public access is disabled. The server uses Render's public URL (`RENDER_EXTERNAL_URL`) to verify request origins and listens on Render's supplied port.

If setting up the service manually instead: choose Node, build with `npm ci --omit=dev`, start with `npm start`, set Node 24.14.0, `NODE_ENV=production`, `DATABASE_URL`, and `APP_ORIGIN` to the exact HTTPS site origin. Create the first admin using the three `ADMIN_*` variables above. The web service and database should be in the same region.

Render references: [Blueprint fields](https://render.com/docs/blueprint-spec) and [Node deployment](https://render.com/docs/deploy-node-express-app).

## 4. Verify the live deployment

1. Open the site's `/health` address: it should return `{"ok":true}`.
2. Sign in using the administrator email and password. A new workspace should be empty. The administrator password supplied by environment bootstrap must be changed on first sign-in.
3. Remove `ADMIN_PASSWORD` from the web service environment after the first successful setup. It is only used if no user exists. Removing it does not remove your account.
4. Add a test invoice and adjust the customer's credit days. Confirm Due and Overdue amounts change as expected.
5. Create an Editor and a Viewer under Settings. Use separate browser sessions to confirm both see shared records, and the Viewer cannot save changes.
6. Open the same revision in two sessions. Save from one, then the other. The second save must request a review/retry instead of discarding the first user's changes.
7. Download a JSON backup and test Previous revisions with a disposable test record.
8. Restart/redeploy the service and verify records remain present.
9. Check the database's backup policy in Render and arrange independent backups before relying on the app for daily operations.

The free database expires 30 days after creation and has no managed backups. Free web services sleep after idle periods. Export workspace backups regularly and upgrade or migrate before the database expires.

After this, import your existing browser data using the README workflow and share the site's HTTPS link with your team. Creating accounts does not send invitation emails; provide each user their sign-in details privately.

## Custom domain

Add the domain in Render and configure its DNS using Render's instructions. Set `APP_ORIGIN` to the exact final HTTPS origin (for example `https://reconcile.example.com`) and redeploy. Use that address consistently; other origins will be rejected for writes.

## Troubleshooting

- **Startup says DATABASE_URL is required:** connect the PostgreSQL database and check the environment variable.
- **Origin is not allowed:** ensure `APP_ORIGIN` matches the address in the browser, including HTTPS and any custom hostname. If not explicitly set, Render's default public URL is used.
- **Please sign in / temporary password:** sign in, or complete the required password change. Ask another admin to reset a forgotten password.
- **Another user saved changes:** the latest shared data has been loaded while keeping form inputs open. Review them and save again.
- **Import rejected:** review the reported field. JSON imports require valid dates, positive amounts, known invoice references and matching customer names. They reject duplicate invoice numbers and markup in text.
- **No data from the previous local version:** browser storage is specific to the original site address. Export from that address and import the JSON on the new live site.
