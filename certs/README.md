# Supabase database trust certificate

`supabase-root.crt` is the public Supabase Root 2021 CA certificate. `supabase-ca.json` contains the same public certificate for static bundling in the Netlify function. Neither file is a private key or a credential.

Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Retrieved 2 November 2026. SHA-256 certificate fingerprint:

`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

Subject and issuer: Supabase Root 2021 CA, Supabase Inc. Valid through 26 April 2031.

The database driver uses it only for Supabase database/pooler hostnames when TLS is enabled, and keeps hostname/certificate verification enabled. Other providers use the system trust store. `DATABASE_SSL_CA` permits an explicit replacement certificate on rotation.

Provider guidance: https://supabase.com/docs/guides/platform/ssl-enforcement
