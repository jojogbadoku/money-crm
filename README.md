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

Note: Render's free tier spins the service down after inactivity, so the first request after idling takes ~30-50s to wake up. Data is stored in a file (`data.json`) on the server's disk, which persists across restarts but is wiped on redeploys — use the Export/Import CSV buttons in the app to back up and restore around a deploy, or set up Google Sheets sync below for an automatic live backup.

### Google Sheets sync (optional)

Every transaction you add can also be automatically appended as a row in a Google Sheet, as a live backup outside the app.

1. Go to https://console.cloud.google.com and create a project (or use an existing one).
2. In that project, go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → Service Account**. Give it any name, click through the defaults, and create it.
4. Open the service account you just created → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file — keep it private, it's a credential.
5. Open that JSON file. You'll need two values from it: `client_email` and `private_key`.
6. Create a new Google Sheet (or use an existing one) at https://sheets.google.com. Click **Share**, and share it with the `client_email` address from the JSON file, giving it **Editor** access.
7. Copy the Sheet's ID from its URL — it's the long string between `/d/` and `/edit`, e.g. `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
8. On Render, go to your service → **Environment**, and add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the `client_email` value
   - `GOOGLE_PRIVATE_KEY` — the `private_key` value (paste it exactly as it appears in the JSON, including the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines)
   - `GOOGLE_SHEET_ID` — the Sheet ID from step 7
   - `GOOGLE_SHEET_NAME` — optional, the tab name to write to (defaults to `Sheet1`)
9. Save — Render redeploys automatically. From then on, every new transaction appends a row: Date, Type, Description, Amount, Entered By, Timestamp.

If these variables aren't set, the app works exactly as before — Sheets sync is entirely optional.
