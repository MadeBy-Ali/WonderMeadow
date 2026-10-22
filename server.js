/* Wonder Meadow — tiny anonymous Q&A backend.
 * Storage lives behind store.js: PostgreSQL when DATABASE_URL is set
 * (production / VPS), a JSON file otherwise (local dev).
 * No accounts, no cookies. Askers get a one-time code; the code is only
 * consumed when it successfully retrieves an answer.
 */
const express = require('express');
const compression = require('compression')
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const ai = require('./ai');

const PORT = process.env.PORT || 3000;

// ---------- ripening rules ----------
// A question closes (its wanderer ascends) at MAX_ANSWERS answers, or RIPEN_WINDOW_MS
// after its FIRST answer, whichever comes first. The store just obeys these numbers.
// (envNumbers is a function declaration, so it is hoisted and can be called here.)
const MAX_ANSWERS = Math.max(1, Math.floor(envNumbers('MEADOW_MAX_ANSWERS', 3)));
const RIPEN_WINDOW_MS = envNumbers('MEADOW_RIPEN_MINUTES', 24 * 60) * 60_000; // env is in minutes
const RIPEN_SWEEP_MS = 30_000; // how often to look for expired questions


const MAX_QUESTION_LEN = 280;
const MAX_ANSWER_LEN = 500;
const MAX_ALIAS_LEN = 24;
const RECENTLY_ANSWERED_MS = 30_000; // answered questions stay in the world list this long so clients can play the ascension
const MAX_OPEN_LISTED = 60;          // keep the meadow light

// ---------- helpers ----------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function makeCode() {
  let raw = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`; // e.g. K3QF-9WMA
}
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function cleanText(input, maxLen) {
  return String(input || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function envNumbers(name, fallback){
  const rawValue = process.env[name];

  const parsedValue = Number(rawValue); // '' -> 0, junk -> NaN: both fall through to the fallback

  if(Number.isFinite(parsedValue) && parsedValue > 0){
    return parsedValue;
  }

  return fallback;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// per-IP rate limiting — the meadow is small and gentle, flooding is neither
function rateLimit(max, windowMs, what) {
  const hits = new Map(); // ip -> { start, count }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (now - h.start > windowMs) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start > windowMs) {
      h = { start: now, count: 0 };
      hits.set(ip, h);
    }
    if (++h.count > max) {
      return res.status(429).json({ error: `The meadow needs a moment to breathe — too many ${what} at once. Try again soon.` });
    }
    next();
  };
}

// ---------- app ----------
const app = express();
app.use(compression());
if(process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath){
    if(filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// The living meadow: open questions + very recently answered ones (for the ascension animation).
app.get('/api/questions', async (req, res) => {
  try {
    res.json({ questions: await store.worldList(RECENTLY_ANSWERED_MS, MAX_OPEN_LISTED) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The meadow stumbled — try again in a moment.' });
  }
});

// Ask: no login, returns the one-time code. The keeper screens it first.
app.post('/api/questions', rateLimit(6, 10 * 60_000, 'questions'), async (req, res) => {
  const text = cleanText(req.body?.text, MAX_QUESTION_LEN);
  if (text.length < 3) {
    return res.status(400).json({ error: 'Your question is a bit too short — give it at least 3 characters.' });
  }
  const color = req.body?.color === 'f' ? 'f' : req.body?.color === 'm' ? 'm' : (Math.random() < 0.5 ? 'f' : 'm');
  const expression = req.body?.expression === 'frown' ? 'frown' : 'smile';
  try {
    const gate = await ai.screen('question', text);
    if (!gate.ok) return res.status(400).json({ error: gate.reason });
    for (let attempt = 0; attempt < 5; attempt++) {
      const q = { id: crypto.randomUUID(), text, code: makeCode(), createdAt: Date.now(), color, expression };
      try {
        await store.create(q);
        return res.status(201).json({ id: q.id, code: q.code });
      } catch (e) {
        if (!e.dup) throw e; // code collision: roll a new one
      }
    }
    throw new Error('could not generate a unique code');
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The meadow stumbled — try again in a moment.' });
  }
});

// Answer: alias required, first answer closes the question. The keeper screens it first.
app.post('/api/questions/:id/answers', rateLimit(15, 10 * 60_000, 'answers'), async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'That little wanderer has left the meadow.' });

  const alias = cleanText(req.body?.alias, MAX_ALIAS_LEN);
  const text = cleanText(req.body?.text, MAX_ANSWER_LEN);
  if (!alias) return res.status(400).json({ error: 'An alias is required — any name will do, but not a blank one.' });
  if (text.length < 2) return res.status(400).json({ error: 'Your answer needs a little more substance.' });

  try {
    const gate = await ai.screen('answer', text, alias);
    if (!gate.ok) return res.status(400).json({ error: gate.reason });
    const result = await store.answer(id, { alias, text, createdAt: Date.now() });
    if (result === 'notfound') return res.status(404).json({ error: 'That little wanderer has left the meadow.' });
    if (result === 'conflict') return res.status(409).json({ error: 'Someone just answered them — they are already ascending!' });
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The meadow stumbled — try again in a moment.' });
  }
});

// One-time code lookup. Only consumed when it actually delivers an answer.
app.post('/api/lookup', rateLimit(30, 10 * 60_000, 'code searches'), async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'Please enter a code.' });

  try {
    const r = await store.lookup(code);
    if (r.status === 'notfound') return res.status(404).json({ error: 'No question matches that code. Check for typos?' });
    if (r.status === 'used') return res.status(410).json({ error: 'This code has already been used — it was one-time only.' });
    if (r.status === 'unanswered') {
      // Don't burn the code on a "nothing yet" check.
      return res.json({ id: r.id, answered: false, consumed: false, text: r.text, createdAt: r.createdAt, color: r.color });
    }
    res.json({ id: r.id, answered: true, consumed: true, text: r.text, createdAt: r.createdAt, color: r.color, answers: r.answers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The meadow stumbled — try again in a moment.' });
  }
});

// ---------- resident wanderers ----------
// The meadow must never open on an empty stage: when open questions run low,
// the keeper (or a small pool of gentle fallbacks) adds a resident wanderer.
const RESIDENT_MIN_OPEN = 3;
const RESIDENT_TOPUP_MS = 5 * 60_000;

async function topUpResidents() {
  try {
    const world = await store.worldList(0, MAX_OPEN_LISTED);
    const open = world.filter((q) => !q.answered);
    let need = RESIDENT_MIN_OPEN - open.length;
    const existing = open.map((q) => q.text);
    while (need-- > 0) {
      const r = await ai.residentQuestion(existing);
      existing.push(r.text);
      for (let attempt = 0; attempt < 5; attempt++) {
        const q = {
          id: crypto.randomUUID(),
          text: cleanText(r.text, MAX_QUESTION_LEN),
          code: makeCode(), // discarded — nobody holds a resident's code
          createdAt: Date.now(),
          color: Math.random() < 0.5 ? 'f' : 'm',
          expression: r.expression,
        };
        try {
          await store.create(q);
          console.log(`  a resident wanders in: “${q.text}”`);
          break;
        } catch (e) {
          if (!e.dup) throw e;
        }
      }
    }
  } catch (e) {
    console.warn('resident top-up stumbled:', e.message);
  }
}

store.init().then(() => {
  topUpResidents();
  setInterval(topUpResidents, RESIDENT_TOPUP_MS).unref();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Wonder Meadow is growing at:`);
    console.log(`    http://localhost:${PORT}`);
    const windowLabel = RIPEN_WINDOW_MS >= 2 * 3_600_000
      ? `${+(RIPEN_WINDOW_MS / 3_600_000).toFixed(1)}h`
      : `${+(RIPEN_WINDOW_MS / 60_000).toFixed(2)} min`;
    console.log(`\n  Ripening: closes at ${MAX_ANSWERS} answers or ${windowLabel} after the first answer`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`    http://${net.address}:${PORT}  (phones on the same wifi)`);
        }
      }
    }
    console.log(`\n  Storage: ${store.kind}`);
    console.log(`  Meadow keeper: ${ai.enabled() ? `on — ${ai.model}` : 'off (set FLAZ_API_KEY and/or ANTHROPIC_API_KEY to enable moderation + AI residents)'}\n`);
  });
}).catch((e) => {
  console.error('Failed to initialize storage:', e);
  process.exit(1);
});
