# 🌱 Running Wonder Meadow locally

## 0. First-time setup

```bash
npm install
```

Create a `.env` file in the project root (next to `docker-compose.yml`). It holds
your secrets, so it is git-ignored and docker-ignored — **never commit it or paste
it anywhere**:

```
POSTGRES_PASSWORD=<paste the output of: openssl rand -hex 24>
FLAZ_API_KEY=
ANTHROPIC_API_KEY=
```

Rules: no quotes, no spaces around `=`, comments on their own line.

| Variable | Needed for | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres and Docker modes | Use hex (`openssl rand -hex 24`) — characters like `@` `:` `/` break the database URL. |
| `FLAZ_API_KEY` | AI keeper (primary) | Optional. Tried first. |
| `ANTHROPIC_API_KEY` | AI keeper (fallback) | Optional. Starts with `sk-ant-`. Used if flaz.id is unavailable (bad token / out of credit / outage). |

Optional extras (all have defaults, see the Ripening section of the README):

| Variable | Notes |
|---|---|
| `MEADOW_MAX_ANSWERS` | answers needed to close a question (default `3`) |
| `MEADOW_RIPEN_MINUTES` | minutes after the first answer before it closes (default `1440`) |
| `MEADOW_HASH_SECRET` | set it in production so "who answered" survives restarts (`openssl rand -hex 24`) |
| `MEADOW_KEEPER_ID` / `MEADOW_KEEPER_ASCEND` | your own never-ascending wanderer; set `ASCEND=1` to let it go |

With **neither** AI key set the keeper is off: no moderation, and the "resident"
wanderers come from a small built-in pool instead of being written by Claude.

## 1. Quick start (simplest — no database)

```bash
npm start
```

Open **http://localhost:3000**. Data is saved to `data/db.json` automatically.

The terminal also prints a LAN URL (e.g. `http://192.168.x.x:3000`) — open that
on your phone if it's on the same wifi.

**With the AI keeper on:** `npm start` does *not* read `.env` by itself, so run

```bash
node --env-file=.env server.js
```

The boot log tells you what's active, e.g. `Meadow keeper: on — flaz.id (claude-haiku-4-5)`
(or `flaz.id (...) → Anthropic (...)` when both keys are set, or `off`).

## 2. With PostgreSQL (like production)

Requires Docker running and `POSTGRES_PASSWORD` in `.env`. The dev override file
publishes the database on `127.0.0.1:5433` so your laptop can reach it (the main
compose file deliberately does not):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
DATABASE_URL=postgres://meadow:<your POSTGRES_PASSWORD>@localhost:5433/meadow node --env-file=.env server.js
```

The server prints `Storage: postgresql` on boot so you know which mode you're in.

To stop Postgres later: `docker compose down` (data survives in a docker volume).

## 3. Full production stack in Docker (app + db together)

```bash
docker compose up -d --build
docker compose logs app
```

App on **http://localhost:3000** (bound to `127.0.0.1` only — it is meant to sit
behind a reverse proxy), everything containerized — same setup as the VPS. Compose
reads `.env` automatically and refuses to start if `POSTGRES_PASSWORD` is missing.
Stop with `docker compose down`.

The **first build can be slow** (the `npm ci` step downloads packages from inside
Docker — several minutes on a slow or VPN-ed connection). Later builds reuse the
cache and take seconds, unless `package.json` / `package-lock.json` change.

After editing `.env`, run `docker compose up -d` again so the containers pick up
the new values.

## Handy things

| I want to… | Do this |
|---|---|
| Reset all questions (JSON mode) | delete `data/db.json`, restart |
| Reset all questions (Postgres) | `docker compose exec db psql -U meadow -d meadow -c "TRUNCATE questions CASCADE"` |
| Wipe the Postgres volume completely | `docker compose down -v` (**deletes all Docker-mode data**) |
| Change the port | `PORT=4000 npm start` |
| Peek at the Postgres data | `docker compose exec db psql -U meadow -d meadow` then `SELECT * FROM questions;` |
| Watch the app logs | `docker compose logs -f app` |
| Check which AI provider is active | look for the `Meadow keeper:` line in the boot log |

## Troubleshooting

- **Port 3000 already in use** → something else is running; use `PORT=4000 npm start`.
- **`ECONNREFUSED …5433`** → Postgres isn't up yet, or you started it without the dev
  override; run the command from section 2 and wait ~5 s.
- **`password authentication failed for user "meadow"`** → the database volume was
  created with an older password; Postgres only reads `POSTGRES_PASSWORD` the first
  time the volume is created. Run `docker compose down -v` (deletes Docker-mode
  data) and start again.
- **`required variable POSTGRES_PASSWORD is missing a value`** → add it to `.env`.
- **`Cannot find module './ai'` in the container** → the Dockerfile's `COPY` line
  must include `ai.js`; rebuild with `docker compose up -d --build`.
- **Keeper says `off`** → neither `FLAZ_API_KEY` nor `ANTHROPIC_API_KEY` reached the
  app. With plain `npm start` use `node --env-file=.env server.js`; with Docker,
  run `docker compose up -d` after editing `.env`.
- **`401 invalid x-api-key` in the log** → a key was sent to a provider that doesn't
  recognise it (e.g. a flaz.id key in `ANTHROPIC_API_KEY`). Each key goes in its own
  variable.
- **Submissions suddenly aren't screened** → the keeper *fails open* by design: if no
  AI provider works, the meadow stays up unmoderated. Check the log for
  `meadow keeper stumbled` / `flaz.id unavailable`.
- **Blank world / no 3D** → the frontend loads Three.js from a CDN, so you need internet access.
- **Wanderers frozen** → browser tabs pause animation while hidden; bring the tab to the front.
