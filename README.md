# Money CRM

Small server that tracks daily money received and expenses. PIN-protected, data stored on the server so it's the same from any device.

## Run locally

```
npm install
APP_PIN=yourpin SESSION_SECRET=someLongRandomString npm start
```

Open http://localhost:3000 and enter your PIN.

## Deploy to Render (free, gives you a public link)

1. Push this folder to a GitHub repo (create the repo on github.com, then `git init`, `git add`, `git commit`, `git push` from here).
2. Go to https://render.com, sign up / log in, click **New +** → **Web Service**, and connect the GitHub repo.
3. Render will detect `render.yaml` automatically. If asked, confirm:
   - Build command: `npm install`
   - Start command: `npm start`
4. Under **Environment**, set:
   - `APP_PIN` — the PIN you'll type to unlock the app (pick something only you know).
   - `SESSION_SECRET` is generated automatically by `render.yaml`.

### Adding a second person

To give someone else their own login (same shared data), set an `APP_USERS` environment variable instead of/in addition to `APP_PIN`, formatted as `Name1:pin1,Name2:pin2`, e.g.:

```
APP_USERS=Jo:1234,Maria:5678
```

Each person logs in with their own PIN, and every transaction now shows who entered it. On Render: go to your service → **Environment** → add `APP_USERS` → save (this triggers a redeploy).
5. Deploy. Render gives you a URL like `https://money-crm-xxxx.onrender.com` — that works from any phone or computer, anywhere.

Note: Render's free tier spins the service down after inactivity, so the first request after idling takes ~30-50s to wake up. By default, data is stored in files (`data.json`, `users.json`) on the server's disk — Render's free plan wipes those on every redeploy or restart. **Set up Google Sheets sync below to make your data (and logins) permanent.**

### Google Sheets sync (recommended — makes data permanent)

When configured, Google Sheets becomes the actual source of truth for both transactions and user logins, instead of the local files — so nothing is lost when Render redeploys or restarts the service. The app automatically creates two tabs in your sheet (`Entries` and `Users`) and keeps them in sync as you use the app. The first time it connects to a sheet, it also migrates in whatever's currently in your local `data.json`/`users.json`, so existing data (like your current users) carries over.

1. Go to https://console.cloud.google.com and create a project (or use an existing one).
2. In that project, go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → Service Account**. Give it any name, click through the defaults, and create it.
4. Open the service account you just created → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file — keep it private, it's a credential.
5. Open that JSON file in a text editor — you'll need `client_email` from it in a moment, and the whole file itself.
6. Create a new Google Sheet (or use an existing one) at https://sheets.google.com. Click **Share**, and share it with the `client_email` address from the JSON file, giving it **Editor** access.
7. Copy the Sheet's ID from its URL — it's the long string between `/d/` and `/edit`, e.g. `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
8. On Render, go to your service → **Environment**:
   - Under **Secret Files**, click **Add file**, name it `gcp-service-account.json`, and paste the *entire contents* of the downloaded JSON file as-is (don't extract individual fields — this avoids formatting mistakes with the private key). Save.
   - Under **Environment Variables**, add:
     - `GOOGLE_APPLICATION_CREDENTIALS` — `/etc/secrets/gcp-service-account.json` (where Render mounts secret files)
     - `GOOGLE_SHEET_ID` — the Sheet ID from step 7
     - `GOOGLE_SHEET_NAME` — optional, tab name for transactions (defaults to `Entries`)
     - `GOOGLE_USERS_SHEET_NAME` — optional, tab name for logins (defaults to `Users`)
9. Save — Render redeploys automatically. Check the deploy logs for `Google Sheets sync ready` to confirm it connected. From then on, every transaction and every user change (add/edit/remove) is read from and written straight to the sheet.

(Alternatively, you can skip the secret file and set `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_PRIVATE_KEY` directly as env vars — but pasting a multi-line private key into a single env var field is easy to get wrong, so the secret file above is the more reliable route.)

If these variables aren't set, or the sheet can't be reached at startup, the app falls back to local files and works exactly as before (with the same data-loss-on-redeploy caveat).
