# Internet Radio Station

A tiny "always on" radio station. Upload audio files through an admin page;
anyone who visits the site hears whatever is currently playing — like tuning
into a real station, not an on-demand playlist. There's no play/pause-per-track,
no skipping, no rewinding to start: you drop in wherever the broadcast
currently is.

## How it works

- The server picks a fixed "station start" timestamp when it boots.
- It knows the duration of every track in the playlist, so at any moment it
  can calculate: given elapsed time since start, which track should be
  playing and how far into it we are (looping the whole playlist forever).
- When a listener loads the page, the browser asks "what's on right now?"
  and seeks its audio player to that exact position.
- Every few seconds the page re-checks and nudges playback back in sync if
  it's drifted, and automatically switches tracks when the "on-air" track
  changes underneath it.

This means everyone tuned in around the same time hears (approximately) the
same thing at the same time — true broadcast behavior, not per-user playback.

## Running it locally

```bash
npm install
cp .env.example .env
```

Open `.env` and set `ADMIN_PASSWORD` to something you'll remember. Then:

```bash
npm start
```

Then open:
- **http://localhost:3000** — the listener page (public, no login)
- **http://localhost:3000/admin.html** — upload and manage the rotation
  (prompts for username/password — default username is `admin`, password
  is whatever you set in `.env`)

Drop MP3/WAV/OGG/M4A/FLAC/AAC files into the admin page. Title/artist are
read from the file's embedded metadata tags if present, otherwise the
filename is used as the title.

### Admin password

The admin page and all admin API routes (upload, delete, reorder) are
protected with HTTP Basic Auth. Credentials come from environment
variables — `ADMIN_USER` (defaults to `admin`) and `ADMIN_PASSWORD`
(required) — never hardcoded in the source. If `ADMIN_PASSWORD` isn't set,
the server prints a warning on startup and leaves admin routes open, so you
don't lock yourself out while experimenting locally — but always set it
before deploying anywhere public.

## Notes & limitations

- **Sync is "close enough," not sample-accurate.** Plain HTML5 `<audio>` has
  network/buffering variance, so different listeners may be off by a second
  or two from each other. The client resyncs every 3 seconds if it drifts
  by more than 2 seconds. For a casual radio-station feel this is fine; true
  sample-accurate sync across listeners would need a different architecture
  (e.g. server-side audio mixing into a single continuous stream via
  something like Icecast/Liquidsoap).
- **Files without readable duration are skipped** from rotation (logged to
  the server console) since the whole scheduling model depends on knowing
  how long each track is.
- **Storage is local disk + a JSON file** (`data/playlist.json`,
  `uploads/`). Fine for a prototype; for production you'd likely want to
  move audio to object storage (S3, etc.) and the playlist to a real
  database, especially on hosts with ephemeral filesystems.
- **Basic Auth over HTTP sends credentials in a form that's trivially
  decoded if intercepted.** Fine over HTTPS (which Render/Railway/Fly all
  give you by default on their subdomains), but don't reuse this password
  anywhere else, and don't run this behind plain HTTP on a public host.

## Deploying to Render (recommended first host)

Render gives you a persistent Node process, a free tier, automatic HTTPS,
and — critically — a persistent disk add-on so uploaded files survive
restarts. Steps:

1. **Push this project to a GitHub repo.**
   ```bash
   git init
   git add .
   git commit -m "Initial radio station"
   ```
   Create a new repo on GitHub and push to it. (`.env` and `uploads/*` are
   already excluded via `.gitignore` — don't commit your real password or
   audio files.)

2. **Create a new Web Service on Render.**
   - Go to [render.com](https://render.com) → New → Web Service
   - Connect your GitHub repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free (fine for a prototype)

3. **Add environment variables** (Render dashboard → Environment):
   - `ADMIN_USER` → your chosen username
   - `ADMIN_PASSWORD` → a strong password

4. **Add a persistent disk** (Render dashboard → Disks) so uploads aren't
   wiped on every redeploy:
   - Mount path: `/opt/render/project/src/uploads`
   - Add a second disk (or the same one, subpath) mounted at
     `/opt/render/project/src/data` for `playlist.json`
   - Render's free tier disk is small but plenty for a prototype's worth
     of tracks

5. **Deploy.** Render builds and gives you a URL like
   `https://your-station.onrender.com`. That's your live listener page;
   `/admin.html` on the same domain is your upload panel.

Note: Render's free tier spins the service down after inactivity and
takes ~30–60 seconds to wake back up on the next request — fine for
sharing with a few people, but worth knowing if the first listener has to
wait a moment. Railway and Fly.io have similar free-tier behavior;
paid tiers on any of these keep it always-on.

## Other hosts

- [Railway](https://railway.app) — similar flow to Render, also supports
  persistent volumes
- [Fly.io](https://fly.io) — more control, has a generous persistent
  volume model, slightly more setup (a `fly.toml` + `flyctl` CLI)
- Any basic VPS — clone the repo, `npm install`, run with `pm2` or a
  systemd service so it survives reboots, put it behind nginx for HTTPS

Avoid static hosts (Netlify, GitHub Pages, Vercel's default serverless
mode) — they can't run a persistent Node process or keep your uploaded
files around between requests.
