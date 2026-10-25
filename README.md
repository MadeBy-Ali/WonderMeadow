# 🌙 Wonder Meadow

A gloomy-but-comforting floating island at twilight, where anonymous questions
wander around as little bald people with a `?` over their heads — until a kind
stranger taps them and answers. Answers *ripen*: a question keeps wandering,
growing brighter, until a few strangers have helped — then it glows gold and
ascends into the blue-purple sky. ✨

No accounts, no logins. Askers get a **one-time code** to retrieve their answer later.

## Run it

> Full local-run instructions (JSON mode, Postgres mode, Docker, troubleshooting): **[RUN.md](RUN.md)**

```bash
npm install
npm start
```

Then open **http://localhost:3000**. The server also prints a LAN URL so phones
on the same wifi can join the meadow (it works on mobile web — one finger to
rotate, two fingers to pan/zoom, tap a wanderer to answer).

## How it works

- **Ask** — type a question, receive a code like `K3QF-9WMA`. That code is the
  *only* way to find your answers, and it works *once*. (Checking before the
  answers are ready does **not** consume it — it's only burned when it actually
  delivers them.)
- **Wander** — every live question is a little blocky 3D person strolling the
  meadow, bobbing `?` overhead. When asking you pick their colour (feminine
  pink or masculine blue) and their mood (a smiling or frowning face).
- **Answer** — tap/click a wanderer, enter an alias (required, never blank) and
  an answer. Your answer is *added* to the question — it doesn't close it on its
  own — and you can answer a given wanderer only once.
- **Ripen** — a question with answers keeps wandering, a little brighter with
  each one. After **3 answers**, or **24 hours** after the first, it closes: the
  person glows gold and lifts off into the sky. (Details in *Ripening* below.)
- **Retrieve** — "I have a code" → paste your code. While your question is still
  ripening you see how many answers have arrived and when it closes; once it has
  closed you read **all** the answers at once, and the code is retired forever.

## Ripening

One careless answer shouldn't be able to close a sincere question, so a question
collects several answers before it ascends.

| State | Meaning | The wanderer |
|---|---|---|
| **open** | no answers yet | wanders with a `?` |
| **ripening** | 1 or more answers, not closed yet | keeps wandering, brighter with each answer |
| **closed** | the answer cap was reached, or the window ran out | glows gold and ascends |

A question **closes** at `MEADOW_MAX_ANSWERS` answers (default **3**), or
`MEADOW_RIPEN_MINUTES` after its **first** answer (default **1440** = 24 hours),
whichever comes first. For a demo, `MEADOW_RIPEN_MINUTES=2` shows the whole life
cycle in a couple of minutes.

| Variable | Meaning | Default |
|---|---|---|
| `MEADOW_MAX_ANSWERS` | answers needed to close a question (whole number ≥ 1) | `3` |
| `MEADOW_RIPEN_MINUTES` | minutes after the first answer before it closes (fractions allowed) | `1440` |
| `MEADOW_HASH_SECRET` | secret used to hash "who answered" (see below) | random on every boot |

Empty, zero, negative or non-numeric values fall back to the default.

- **One answer per person per question.** Each answer stores a keyed hash of the
  visitor's IP address *plus the question's id*. The same person gets the same hash
  on the same question (so a second answer is refused) but a different hash on every
  other question, so nobody can be tracked across the meadow — and the IP address
  itself is never stored. Set `MEADOW_HASH_SECRET` in production: without it a
  random secret is made at each boot, so the duplicate check forgets everyone on
  restart. (Postgres also enforces this with a unique index.)
- **While ripening, answers stay hidden.** The asker's code shows only the count and
  the closing time and is *not* used up; the answers are delivered, all at once,
  after the question closes.
- **Time-outs are enforced twice.** A sweeper closes expired questions every 30
  seconds, and an answer or lookup that arrives after the deadline closes the
  question on the spot, so the rule never depends on the timer having run.
- **Concurrency.** In Postgres the question's row is locked while an answer is
  added, so strangers racing for the last slot can't push a question past its cap.
- **Upgrading.** Existing data is converted automatically on first boot (earlier
  "answered" questions become closed ones, keeping their answers).

## The meadow keeper (AI)

Give the server an API key and Claude becomes part of the meadow itself:

- **The gate** — every question and answer is screened before it enters.
  Genuine questions (including heavy, sad ones — that's what the meadow is
  for) pass freely; spam, cruelty, and gibberish are turned away with a
  gentle one-line reason. If no AI provider is reachable, the gate fails open
  so the meadow never goes down with it (it just runs unscreened).
- **Resident wanderers** — the meadow never opens on an empty stage. When
  fewer than 3 questions are wandering, the keeper writes a new gentle
  question and releases it as a resident (checked at startup and every
  5 minutes). With no working provider, residents come from a small built-in
  pool instead.

**Providers, tried in order:**

1. **flaz.id** (`FLAZ_API_KEY`) — an OpenAI-style `/chat/completions` gateway.
2. **Anthropic** (`ANTHROPIC_API_KEY`) — the official API, with structured outputs.

If flaz.id rejects the token or the credit runs out (HTTP 401/402/403, or an
error mentioning credit/balance/quota/billing), it is skipped for 10 minutes and
Anthropic takes over; a timeout or 5xx skips it for 60 seconds. Each key is only
ever sent to its own provider, and every call is time-limited (8 s for flaz.id,
15 s for Anthropic) so a stuck provider can't hang a submission.

| Variable | Purpose | Default |
|---|---|---|
| `FLAZ_API_KEY` | primary provider key | — |
| `FLAZ_BASE_URL` | primary provider endpoint | `https://ai.flaz.id/v1` |
| `FLAZ_MODEL` | model used on the primary provider | `claude-haiku-4-5` |
| `ANTHROPIC_API_KEY` | fallback provider key | — |
| `MEADOW_AI_MODEL` | model used on Anthropic | `claude-haiku-4-5` |

> Visitors' questions and answers are sent to whichever provider screens them —
> worth knowing before you launch publicly. Set a monthly spend limit on every key.

The server also rate-limits per IP (6 questions / 15 answers / 30 lookups per
10 minutes) so one visitor can't flood the meadow. Behind a reverse proxy, set
`TRUST_PROXY=1` so the limiter sees each visitor's real IP (see *Deploying*).

## Stack

| Piece    | Tech |
|----------|------|
| Frontend | Three.js (CDN) + vanilla JS/CSS — no build step |
| Backend  | Node + Express |
| AI       | Claude Haiku via flaz.id (primary) with Anthropic SDK fallback — moderation gate + resident questions (optional) |
| Storage  | PostgreSQL in production (`DATABASE_URL`), JSON file fallback for local dev |

## Deploying to a VPS

Everything is dockerized. On the server:

1. Copy the project over **without** your local `.env`.
2. Create a fresh `.env` *on the server* (new values — don't reuse your laptop's
   secrets), then lock it down:
   ```bash
   # POSTGRES_PASSWORD=<openssl rand -hex 24>
   # FLAZ_API_KEY=...        (optional, primary AI provider)
   # ANTHROPIC_API_KEY=...   (optional, fallback AI provider)
   # MEADOW_HASH_SECRET=<openssl rand -hex 32>   (keeps the one-answer-per-person check across restarts)
   chmod 600 .env
   ```
3. Bring up Postgres + the app:
   ```bash
   docker compose up -d --build
   docker compose logs app     # expect: Storage: postgresql / Meadow keeper: on — ...
   ```
4. Put a TLS reverse proxy in front, e.g. Caddy on the same machine:
   ```
   meadow.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

How the compose file is hardened for this:

- **Secrets** live only in `.env`; compose refuses to start without `POSTGRES_PASSWORD`.
- **Postgres is not published** to the host — the app reaches it over the internal
  docker network. Data persists in the `meadow-data` volume.
- **The app is bound to `127.0.0.1:3000`**, so only the reverse proxy on the same
  machine can reach it. Don't change this to `3000:3000`: with `TRUST_PROXY=1` a
  visitor hitting the app directly could forge `X-Forwarded-For` and dodge the
  rate limits.
- **`TRUST_PROXY=1`** tells Express there is exactly one proxy hop (Caddy), so
  `req.ip` is each visitor's real address. Leave it **unset** when running without a
  proxy (e.g. local dev). Adding a second hop such as Cloudflare in front of Caddy
  needs extra setup (the visitor IP then arrives in `CF-Connecting-IP`, and the
  origin should only accept Cloudflare's IP ranges) — that is **not wired up yet**.

**Backups** — the database is the only state worth saving:

```bash
docker compose exec -T db pg_dump -U meadow meadow | gzip > meadow-$(date +%F).sql.gz
```

**Capacity notes** — in a local loopback test (laptop, 60 open questions) the
polling endpoint served roughly 12k requests/s at p99 ≈ 25 ms, versus the ~500/s
that 2,000 simultaneous visitors would generate. That is a local measurement, not a
production benchmark, and it was taken before ripening was added. Since then, on a
100,000-row database with a 40,000-question backlog, the poll query takes about
0.04 ms and the sweeper about 0.8 ms, because both use partial indexes (live
questions, recently closed, ripening deadlines) instead of scanning the table —
without a suitable index, a big backlog of unanswered questions made every poll scan
and sort the whole table. Responses are gzipped (about 7× smaller for a full
60-question list).

Local development against real Postgres, and the full command list, are in
**[RUN.md](RUN.md)**. Plain `npm start` (no `DATABASE_URL`) uses the JSON file —
handy for hacking on the frontend.

## The answered realm

When an asker's one-time code finds a question that has closed, the screen dissolves
into a calm place above the clouds: drifting white clouds, a soft golden glow,
their wanderer floating there — bald as ever, but smiling now, sparkle overhead —
and the question with all of its answers set in quiet serif type. The happy sunlit
meadow peeks from below. One button leads back down to the twilight island.

## World details

The world is deterministic (seeded RNG), so everyone sees the same island —
a round floating island with cliff edges and a jagged rocky underside, drifting
in a starry blue-purple dusk with a soft moon, fireflies, dark clouds, and
small floating rock islets around it. On the island: rolling hills, a cliff
waterfall, a winding river that pours off the island's rim into the sky, two
arched bridges, a campsite (tents + flickering campfire), a fenced crop farm,
a lantern-lit fishing dock, and a quiet stargazing hill. Blob shadows and
Lambert materials keep it light on mobile GPUs.

A light drizzle falls in a small pocket around the camera — a private shower
that follows your point of view instead of soaking the whole island — and the
camera is terrain-aware: it can't dip under the grass, through the hills, or
into the waterfall cliff (peeking below the horizon from outside the rim is
still allowed — it *is* a floating island). A gloomy-but-comforting ambient
soundscape (low drone, a short repeating music-box melody in A minor,
wandering wind, rain patter) is
synthesized live with the Web Audio API — no audio files — and starts on the
first tap; the 🔊 button in the top bar mutes it, and the choice is remembered.

The wanderers roam slowly and have little lives: between strolls they randomly
visit activity spots — warming up at the campfire, tending the crops, fishing
off the dock, gazing from the bridge, or stargazing — then move on to something
else. If their path crosses the river, they politely route over a bridge.
Each activity spot holds one visitor at a time. Every so often a wanderer
stops, turns, and looks straight up at the camera — at you.

Frowning wanderers have one extra habit: once in a while they drift out to a
lonely ledge on the island's rim and sit alone at the edge — knees up, arms
wrapped around them, head bowed toward the sky below — for a long, quiet
while, before collecting themselves and wandering back. The ledges are spread
far apart and each holds only one sitter, so they always sit alone.

## Small ceremonies

- **The opening descent** — the camera starts far above the clouds and glides
  down onto the island over ~5 seconds. Any tap skips it.
- **Shared ascensions** — when someone else's question closes (enough answers,
  or its window ran out), every open browser gets a quiet toast while the
  wanderer rises.
- **The keepsake card** — the code modal offers a 🖼 keepsake: a downloadable
  twilight card with your wanderer, your question, and your one-time code, so
  the code can't be lost to a closed tab.
- **The dusk breathes** — moonlight, fog, and starlight drift on a slow
  8-minute cycle, so the island never feels frozen.

## Camera

Tapping a wanderer (or asking a question, or searching an unanswered code)
flies the camera in and locks onto them; it keeps following as they walk,
fish, cross bridges — and rises with them when they ascend. You can still
orbit and zoom while locked. Tap empty ground or the "Following" chip to
let the camera roam free again. The answer card has a minimize button (–)
that tucks it into a chip at the bottom of the screen, so you can watch
the wanderer while you think of your answer.

Clients poll `GET /api/questions` every 4 s; closed questions stay in the feed
for 30 s so every open browser gets to watch the ascension.

### API

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET  | `/api/questions` | — | live (open + ripening) and recently closed questions. Each item: `id`, `text`, `color`, `expression`, `answerCount`, `closedAt` (`null` while live). `answered` / `answeredAt` are kept for older clients and mean "closed" / `closedAt`. |
| POST | `/api/questions` | `{text, color?, expression?}` | `color` is `f`/`m`, `expression` is `smile`/`frown`; returns `201 {id, code}`; `400` with a gentle reason if the keeper declines it |
| POST | `/api/questions/:id/answers` | `{alias, text}` | `201 {ok, count, closed}`; `409` the question has already closed; `400` you already answered it, the alias is blank, or the keeper declined it; `404` unknown question |
| POST | `/api/lookup` | `{code}` | `200` open → `{answered:false}`; `200` ripening → `{answered:false, ripening:true, count, closesAt}` (answers hidden, code **not** used); `200` closed → `{answered:true, answers:[...]}` and the code is retired; `404` unknown code; `410` already used |

All three `POST` routes are rate-limited per IP and return `429` when exceeded.

### Dev console goodies

`window.__meadow` exposes `camera`, `controls`, `characters`, `ui`, and
`startAscension` for poking around. `window.__timeScale = 0.2` slow-mos the world.
