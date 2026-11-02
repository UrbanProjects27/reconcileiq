# Microsoft 365 OneDrive setup

An administrator connects one Microsoft 365 account for the ReconcileIQ workspace.
The integration supports secure sign-in, persistent encrypted credentials,
folder browsing, importing Excel/CSV records after preview, opening source files,
and disconnecting. Synchronization runs manually when an administrator imports a
file. No recurring schedule is enabled.

## 1. Register ReconcileIQ

Open https://entra.microsoft.com/ with your work or school account.
Choose **Entra ID → App registrations → New registration**.

- Name: **ReconcileIQ**
- Supported account types: **Accounts in this organizational directory only** (single tenant).
- Redirect URI platform: **Web**
- Redirect URI: `https://reconcileiq-urbanretail.netlify.app/api/onedrive/callback`

If the registration page does not offer a redirect URI, register first, then use
**Authentication → Add a platform → Web**. Leave implicit grant and public-client
flows disabled. This application exchanges authorization codes on the server.

From **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
These identifiers are safe to share with your app maintainer.

## 2. Set delegated permissions

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**,
add **Files.Read**. It permits reading the connected user's files. This connector
does not use application permissions or write permissions. Remove the default
`User.Read` permission if it is present; this connector does not call `/me`.

Microsoft's authentication library also requests `openid`, `profile`, and
`offline_access` during authorization, to identify the connected account and renew
access without repeated sign-ins. Your organization's consent policy may require a
Microsoft 365 administrator to approve the requested permissions.

## 3. Create a client secret

Choose **Certificates & secrets → Client secrets → New client secret**.
Use a description such as `ReconcileIQ Netlify`, select an expiry according to your
company policy, then copy the **Value** immediately. The **Secret ID** is not the
value. Keep the value out of chat, source files, and screenshots.

Record the expiry and rotate the secret in Netlify before it expires.

## 4. Set Netlify environment variables

Open https://app.netlify.com/projects/reconcileiq-urbanretail/configuration/env .
Add the following to **Production**, including the **Functions** scope:

| Key | Value | Mark as secret |
| --- | --- | --- |
| `ONEDRIVE_CLIENT_ID` | Application (client) ID | No |
| `ONEDRIVE_TENANT_ID` | Directory (tenant) ID | No |
| `ONEDRIVE_CLIENT_SECRET` | Client secret **Value** | Yes |
| `ONEDRIVE_TOKEN_KEY` | A newly generated 32-byte key as 64 hexadecimal characters | Yes |

A token key has been generated locally in `.env.onedrive-key` for this deployment.
Copy its value directly into Netlify. Keep a secure backup of this key: changing it
prevents the app from opening previously saved credentials. Disconnect and reconnect
if a key is lost. The file is excluded from Git and the public build.

If no local key file exists, generate a key with Node:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

After saving all four variables, redeploy so the function receives the new values.
The existing `APP_ORIGIN` must remain `https://reconcileiq-urbanretail.netlify.app`.
For local testing, register a separate Web callback for the local origin and keep
test credentials separate from production.

## 5. Connect and verify

Sign into https://reconcileiq-urbanretail.netlify.app as an administrator.
Open **Settings → Microsoft OneDrive → Manage connection → Connect Microsoft 365**.
Sign into the account that owns the source files and approve the requested access.
After returning, open **Manage connection → Browse files** and check a folder.
The account must have a licensed, provisioned OneDrive and access to those files.

Connecting does not change invoices, customer balances, or other workspace records.
Only ReconcileIQ administrators can browse the connected account. Workspace JSON
backups do not contain tokens. The server stores the MSAL token cache encrypted with
AES-256-GCM in private database tables with RLS and no browser grants.

**Disconnect** removes the app's stored credentials and pending authorization
requests. To revoke Microsoft-side consent as well, have your Microsoft 365
administrator revoke the application's grant in Enterprise applications.

## 6. Import spreadsheet data

1. Open **Manage connection → Browse files** and navigate to the source folder.
2. Select **Import** beside an `.xlsx` or `.csv` file. Save legacy `.xls` files as
   `.xlsx` first. CSV files must use UTF-8 and comma separators.
3. Select the worksheet and data type. Import invoices before related payment
   advice, sales returns, price returns or debit notes.
4. Choose the header row and date format, then review the suggested column mapping.
   Required fields have an asterisk. Keep invoice and bank reference numbers as
   text in Excel to preserve leading zeros.
5. Select **Preview import**. Review new records, duplicates, updates and errors.
6. Fix any reported errors or conflicting identifiers before importing. All rows
   are blocked while validation errors remain. Identical records are skipped.
7. Select **Confirm import**. The records are saved to the shared database and
   appear in the dashboard and registers. A recovery snapshot and audit event are
   created. If another user saved after the preview, review the rebuilt preview.

Supported data types: invoices, customer credit days, bank receipts, payment advice,
sales returns, price returns and debit notes. Invoice material descriptions are
ignored. Credit days belong to customers; use **Customer credit days** to update
existing terms, or **Customer Summary → Manage credit days**. New customers default
to 45 days when importing invoices.

Imports add transaction records and skip identical existing ones. They do not
replace conflicting transaction records. Customer credit-day mappings can be
updated explicitly, with update counts shown in the preview. Unrelated workspace
records are retained.

File limits: 4 MB, 5,000 data rows plus a header per worksheet, 100 columns,
20 worksheets and 100,000 cells across the workbook. Large archives are rejected
before parsing. Split larger files into smaller workbooks or CSV files.

## References

- https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
- https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests
- https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0
