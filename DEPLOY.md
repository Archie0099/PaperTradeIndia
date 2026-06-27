# Deploying Paper Trade India (free)

This puts the app on a **public URL** so you can open it from anywhere — including
the bot tournament, which then keeps running on the server instead of your
laptop. It stays **100% free** and **simulation-only** (no real orders, no API
keys, no paid services).

> The app is already cloud-ready: it listens on `process.env.PORT` and needs no
> `.env`. The only files added for deployment are `render.yaml` and this guide.

---

## Option A — Render.com (recommended, free)

Render runs a real Node server 24/7 on its free tier. You need a free GitHub
account and a free Render account.

### 1. Put the code on GitHub
From the project folder, in your terminal:

```bash
git init
git add -A
git commit -m "Initial commit"
```

Create an empty repo on github.com (e.g. `PaperTradeIndia`), then:

```bash
git remote add origin https://github.com/<your-username>/PaperTradeIndia.git
git branch -M main
git push -u origin main
```

(If you have the GitHub CLI: `gh repo create PaperTradeIndia --public --source=. --push`.)

### 2. Deploy on Render
1. Go to **render.com** → sign in with GitHub.
2. **New +** → **Blueprint** → pick your `PaperTradeIndia` repo.
   Render detects `render.yaml` and sets everything up — just click **Apply**.
   *(Or: **New +** → **Web Service** → your repo → Build `npm install`, Start
   `npm start`. Render fills in the port automatically.)*
3. Wait ~2 minutes for the build. You get a URL like
   `https://paper-trade-india.onrender.com` — open it. Done.

### 3. (Optional) Keep it awake
Render's **free** tier sleeps a web service after ~15 minutes of no traffic
(the first visit after that takes ~30s to wake up). The tournament only advances
while the server is awake, so to keep the daily race ticking, set up a free
**uptime pinger**:
- Go to **cron-job.org** (free), add a job that GETs
  `https://<your-app>.onrender.com/api/status` every 10 minutes.

### 4. (Optional) Lock it with a password — only you can open it
The app supports a built-in password lock that activates **only when an
environment variable is set on the host** (so the password never goes in the
code or on GitHub). To turn it on:
1. In Render → your service → **Environment** → **Add Environment Variable**:
   - Key: `APP_PASSWORD`  ·  Value: *(any password you like)*
   - (Optional) Key: `APP_USER`  ·  Value: *(a username; defaults to `admin`)*
2. **Save** — Render redeploys automatically. Now opening the URL prompts for the
   username + password; only the right combination gets in.
- `/api/status` stays open (no password) so the uptime-pinger above still works.
- To remove the lock, delete the `APP_PASSWORD` variable.
- Locally it stays open (no `APP_PASSWORD` set), so `npm start` never prompts.

---

## Option B — Railway / Fly.io
Both have free allowances and the same flow: connect the GitHub repo, build
`npm install`, start `npm start`. Node 18+ is required (set in `package.json`
`engines`). No other config needed.

## Option C — Just share your laptop temporarily
For a quick demo without deploying, run the app locally (`npm start`) and expose
it with a free tunnel:
```bash
npx localtunnel --port 3000      # or: ngrok http 3000
```
This gives a temporary public URL that forwards to your machine (only works while
your laptop + the command stay running).

---

## Things to know about the free hosting

- **Tournament state is ephemeral.** Free hosts use a temporary disk, so the
  bots' forward track (`data/tournament.json`) resets whenever the service
  redeploys or restarts. The full historical backfill (~20 years of daily bars)
  regenerates automatically; only the *live-since-deploy* days reset. (For
  permanent history later, add a free database — not needed for now.)
- **Market data:** Yahoo (equity/index quotes + history) normally works fine from
  a cloud host. NSE's option chain often blocks datacenter IPs → the app falls
  back to cached, then synthetic data (clearly labelled). This is expected; the
  option tools and the modelled-F&O tournament still work.
- **Still simulation-only.** There is no code path that places a real order, and
  no secret or API key is ever required. Nothing to leak.
