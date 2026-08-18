# Apply Mate

A small Next.js web app that connects your Gmail account and sends
personalized job-application emails to many HRs at once — same body, but the
**company name** and **role** (and therefore the subject) change per recipient.
Optionally attaches your resume to every email.

## What it does

1. Connect your Google account (OAuth — only the "send email" permission is requested).
2. Write one subject + body template using `{company}`, `{role}`, `{name}` placeholders.
3. Add recipients in a table (HR email, company, role) — or paste/import a CSV.
4. Optionally upload a resume (attached to every email).
5. Preview, then send. Emails go out one-by-one with a small randomized delay
   (better for Gmail deliverability). Every send is logged to Supabase.

## Tech

- **Next.js** (App Router) + **React** + **Tailwind CSS**
- **Auth.js / NextAuth v5** — Google OAuth
- **googleapis** — Gmail API for sending
- **Supabase** — Postgres (accounts, campaigns, send log) + Storage (resume)

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. Go to **Project Settings → API** and copy the **Project URL** and the
   **`service_role` secret key** (not the anon key).
   - The `resumes` storage bucket is created automatically on first upload.

### 3. Google OAuth

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → Library** → enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**. Fill in the required app info.
   - Add the scopes `https://www.googleapis.com/auth/gmail.send` and
     `https://www.googleapis.com/auth/gmail.readonly` (the latter powers the
     "Sent & follow-ups" page).
   - Under **Test users**, add your own Gmail address (required while the app
     is in "Testing" mode — otherwise Google blocks sign-in).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
   - Copy the **Client ID** and **Client secret**.

### 4. Environment variables

```bash
cp .env.local.example .env.local
```

Fill in `.env.local`:

- `AUTH_SECRET` — generate with `npx auth secret`
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — from step 3
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from step 2
- `CRON_SECRET` — any long random string (e.g. `openssl rand -hex 32`);
  protects the `/api/cron` endpoint that fires scheduled sends

### 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>, click **Connect Google account**, grant the
"send email" permission, and start sending.

---

## Scheduled sends

Campaigns can be scheduled from the compose page ("Schedule send"). The
mail data is stored in Supabase and a processor sends it when the time
comes — the browser doesn't need to stay open.

**Existing databases:** re-run [`supabase/schema.sql`](supabase/schema.sql)
in the Supabase SQL Editor once — it adds the scheduling columns (the
statements are idempotent).

Two things can trigger the processor (both are safe to run together —
campaigns are claimed atomically, so nothing double-sends):

1. **While the app's server is running** (local `npm run dev` / `npm start`):
   a background poller checks every minute automatically. Nothing to set up.
2. **When your machine may be off**: deploy the app (e.g. Vercel) and let a
   cron hit `GET /api/cron` with the header
   `Authorization: Bearer <CRON_SECRET>`.
   - On **Vercel**, [`vercel.json`](vercel.json) already schedules it every
     5 minutes — just set the `CRON_SECRET` env var in the project settings
     (Vercel attaches the header automatically). Note: the Hobby plan limits
     how often crons run (daily); Pro allows minute-level schedules. Also set
     `AUTH_*` / `SUPABASE_*` env vars and add your production callback URL in
     Google Cloud.
   - Any other scheduler (GitHub Actions, cron-job.org, a Raspberry Pi
     crontab…) works the same way: `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron`
   - On a long-running host (e.g. **Render**), the in-app poller from (1)
     already runs — you only need to keep the service awake. Point any free
     uptime pinger (cron-job.org, UptimeRobot) at `GET /api/health` every
     5–10 minutes; no secret required for that endpoint.
3. A campaign whose time passed while nothing was running is sent on the
   next processor run ("as soon as possible", like Gmail).

## Notes & limits

- **Gmail sending limits:** a normal Gmail account can send ~500 recipients/day
  (Google Workspace ~2000). Stay well under that.
- **Deliverability:** sends are sequential with a randomized delay (configurable
  in the UI). Blasting hundreds instantly looks like spam — keep batches modest.
- **Long batches:** each send waits for the delay, so a large batch takes a while.
  This runs fine locally. If you deploy to a serverless host (e.g. Vercel), the
  `/api/send` route has `maxDuration = 300` (5 min); very large batches may need
  a background-job approach instead.
- **Refresh token:** captured on first sign-in and stored in Supabase. If sending
  ever fails with an auth error, sign out and sign in again to refresh it.
- **Privacy:** the Supabase service-role key and OAuth secret live only in
  `.env.local` (gitignored) and are used server-side only.
