# FilesDevxyz

Jepong's own Mediafire-style file host. Upload anything, share a short link.

## How it works

The browser uploads **straight to Cloudflare R2** via presigned URLs — Vercel
serverless functions only *sign* URLs, they never touch file bytes (Vercel
can't accept 100MB+ request bodies anyway).

```
index.html  →  POST /api/sign-upload            (≤100MB, single presigned PUT)
            →  POST /api/sign-part              (>100MB, multipart: 10MB parts)
            →  PUT <presigned urls>             (browser → R2 directly, with progress)
            →  POST /api/complete-multipart
f.html      →  GET  /api/resolve?id=<id>         (password/expiry check → presigned GET)
```

- Short links: `/f/<8-char-id>` (rewritten to `f.html?id=<id>` via `vercel.json`)
- R2 key layout: `<id>/<original-filename>`
- Passwords: SHA-256 hash in `x-amz-meta-pw` object metadata (constant-time compare)
- Expiry: epoch-ms in `x-amz-meta-exp` metadata (410 when past)
- "My files" list lives in `localStorage` on the uploader's device
- **Storage cap:** uploads are refused with HTTP 507 before the bucket can
  grow past `STORAGE_CAP_GB` (default 9GB), so the R2 free tier is never
  exceeded. Set `STORAGE_CAP_GB=0` to disable.
- **Auto-delete:** `/api/cleanup` runs daily via Vercel Cron (`vercel.json`)
  and deletes every object older than `RETENTION_DAYS` (default 7).
  Guarded by `CRON_SECRET` (Bearer token) — set a long random string in Vercel.

## Setup

1. Create an R2 bucket + API token (Object Read & Write) in the Cloudflare dashboard.
2. Copy `.env.example` to `.env` (local) and set the same vars in
   Vercel → Project → Settings → Environment Variables (all environments).
3. `npm install`, `npm test`, then deploy to Vercel.

No real credentials are stored anywhere in this repo — config is env-vars only.

## Tests

```
npm test
```

Unit + handler tests use mocked S3 clients (no real R2 needed).
The jsdom smoke tests run the real page scripts with mocked `fetch`/`XMLHttpRequest`.

### Not covered by tests (needs real R2 credentials)

- The actual presigned-URL handshake against Cloudflare R2
  (SigV4 signing, multipart create/complete against the live endpoint)
- Real browser upload of a 100MB+ file end-to-end
- The `/f/:id` rewrite (needs a Vercel deployment to verify)
