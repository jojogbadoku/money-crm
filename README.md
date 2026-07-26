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
5. Deploy. Render gives you a URL like `https://money-crm-xxxx.onrender.com` — that works from any phone or computer, anywhere.

Note: Render's free tier spins the service down after inactivity, so the first request after idling takes ~30-50s to wake up. Data is stored in a file (`data.json`) on the server's disk, which persists across restarts but is wiped on redeploys — fine for personal use, but if that matters to you later, ask to upgrade this to a real database.
