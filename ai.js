/* Wonder Meadow — the meadow keeper.
 * Two jobs:
 *   screen(kind, text, alias)  — the gate: only genuine questions and kind
 *                                (or at least non-cruel) answers enter the meadow
 *   residentQuestion(existing) — writes a gentle "resident" question when the
 *                                meadow is empty, so it never opens on a dead stage
 *
 * Providers, tried in this order:
 *   1. flaz.id   (OpenAI-style /chat/completions)   — set FLAZ_API_KEY
 *   2. Anthropic (official API, structured outputs) — set ANTHROPIC_API_KEY
 *                                                     (MEADOW_AI=1 for an `ant auth login` profile)
 * If flaz.id rejects the token or the credit runs out (HTTP 401/402/403, or an
 * "insufficient credit"-style error), it is skipped for 10 minutes and Anthropic
 * takes over. A timeout or 5xx skips it for 60 seconds; a malformed reply falls
 * back for that one call only. If no provider works, the keeper fails open: the
 * meadow keeps running, just unscreened. Each key is only ever sent to its own
 * provider.
 */
const MODEL = process.env.MEADOW_AI_MODEL || 'claude-haiku-4-5';

const FLAZ_KEY = (process.env.FLAZ_API_KEY || '').trim();
const FLAZ_URL = (process.env.FLAZ_BASE_URL || 'https://ai.flaz.id/v1').replace(/\/+$/, '');
const FLAZ_MODEL = process.env.FLAZ_MODEL || 'claude-haiku-4-5';
const FLAZ_TIMEOUT_MS = 8000;           // a stuck provider must not hang a submission
const FLAZ_COOLDOWN_MS = 10 * 60_000;   // after an auth/credit failure, skip flaz.id this long
const FLAZ_BRIEF_COOLDOWN_MS = 60_000;  // after a timeout / 5xx, skip it briefly

let client = null;
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.MEADOW_AI) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    // short timeout + one retry: the SDK default is 10 minutes, far too long to hold up a submission
    client = new Anthropic({ timeout: 15_000, maxRetries: 1 });
  } catch (e) {
    console.warn('meadow keeper: Anthropic fallback disabled (could not init client):', e.message);
  }
}

// ---------------------------------------------------------------- providers
// Tolerant JSON extraction — chat models sometimes wrap JSON in prose or code fences.
function parseJSON(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in reply');
  return JSON.parse(m[0]);
}

async function viaFlaz({ system, user, jsonHint, temperature, validate }) {
  let res;
  try {
    res = await fetch(`${FLAZ_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FLAZ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FLAZ_MODEL,
        max_tokens: 300,
        ...(temperature !== undefined && { temperature }),
        messages: [
          { role: 'system', content: `${system}\n\nReply with ONLY a JSON object, no prose and no code fences, shaped like: ${jsonHint}` },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(FLAZ_TIMEOUT_MS),
    });
  } catch (e) {
    const err = new Error(`network/timeout: ${e.message}`);
    err.cooldownMs = FLAZ_BRIEF_COOLDOWN_MS; // provider looks down — don't make every visitor wait for the timeout
    throw err;
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`HTTP ${res.status} ${body}`.trim());
    if ([401, 402, 403].includes(res.status) || /insufficient|credit|balance|quota|billing/i.test(body)) {
      err.cooldownMs = FLAZ_COOLDOWN_MS;       // bad/revoked token, payment required, or out of credit
    } else if (res.status >= 500) {
      err.cooldownMs = FLAZ_BRIEF_COOLDOWN_MS; // provider-side outage
    }
    throw err;
  }
  const json = await res.json();
  const data = parseJSON(json?.choices?.[0]?.message?.content);
  validate(data);
  return data;
}

async function viaAnthropic({ system, user, schema, validate }) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  });
  const block = res.content.find((b) => b.type === 'text');
  const data = JSON.parse(block.text);
  validate(data);
  return data;
}

let flazDownUntil = 0;

async function ask(opts) {
  if (FLAZ_KEY && Date.now() >= flazDownUntil) {
    try {
      return await viaFlaz(opts);
    } catch (e) {
      if (e.cooldownMs) {
        flazDownUntil = Date.now() + e.cooldownMs;
        console.warn(`meadow keeper: flaz.id unavailable (${e.message}) — ${client ? 'using Anthropic' : 'no fallback configured'} for the next ${Math.round(e.cooldownMs / 1000)}s`);
      } else {
        console.warn(`meadow keeper: flaz.id call failed (${e.message})${client ? ' — trying Anthropic' : ''}`);
      }
    }
  }
  if (client) return await viaAnthropic(opts);
  throw new Error('no AI provider available');
}

// ----------------------------------------------------------------- the gate
const GATE_PROMPT = `You are the gatekeeper of Wonder Meadow, a small anonymous kindness app:
people whisper a question into a 3D meadow, and strangers answer it gently.

You receive one JSON submission: {"kind": "question"|"answer", "text": ..., "alias"?: ...}.
Decide whether it may enter the meadow.

ALLOW (be generous):
- genuine questions of any kind — practical, silly, philosophical
- heavy or sad feelings (loneliness, grief, heartbreak, anxiety). The meadow exists for these.
- imperfect grammar, any language, short-but-sincere text
- answers that are kind, wise, funny, or wonderfully weird

REJECT only:
- spam, ads, link drops, keyboard-mash gibberish, or obvious flooding
- harassment, hate, slurs, or cruelty (for answers: mockery of the asker)
- sexual content involving minors, or explicit sexual content generally
- doxxing / posting someone's personal information
- instructions for serious harm (weapons, self-harm methods). A person *expressing*
  self-harm feelings is ALLOWED — a method request or encouragement is not.
- for aliases: slurs or impersonation of the meadow itself

When rejecting, write "reason" as one short gentle sentence in the meadow's voice,
e.g. "The meadow only makes room for genuine questions." Never lecture.`;

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    allow: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['allow', 'reason'],
  additionalProperties: false,
};

function enabled() {
  return !!(FLAZ_KEY || client);
}

async function screen(kind, text, alias) {
  if (!enabled()) return { ok: true };
  try {
    const verdict = await ask({
      system: GATE_PROMPT,
      user: JSON.stringify({ kind, text, alias }),
      schema: GATE_SCHEMA,
      jsonHint: '{"allow": true|false, "reason": "<one short gentle sentence>"}',
      temperature: 0,
      validate: (d) => { if (typeof d.allow !== 'boolean') throw new Error('verdict missing boolean "allow"'); },
    });
    if (verdict.allow) return { ok: true };
    return { ok: false, reason: verdict.reason || 'The meadow gently declined this one.' };
  } catch (e) {
    console.warn('meadow keeper stumbled (allowing submission):', e.message);
    return { ok: true }; // fail open — the keeper must never take the meadow down
  }
}

// ---------------------------------------------------------------- residents
// Fallback residents for when no AI provider is configured (or all are down):
// gentle, answerable questions so the meadow never looks abandoned.
const RESIDENT_POOL = [
  { text: 'How do I stop replaying conversations in my head at 2am?', expression: 'frown' },
  { text: 'What small thing made you smile this week?', expression: 'smile' },
  { text: 'Is it normal to feel lonely even around friends?', expression: 'frown' },
  { text: 'What do you say to yourself on days when nothing goes right?', expression: 'frown' },
  { text: 'How did you know what you wanted to do with your life?', expression: 'smile' },
  { text: 'What food instantly makes a bad day better?', expression: 'smile' },
  { text: 'How do you forgive someone who never said sorry?', expression: 'frown' },
  { text: 'If you could tell your younger self one thing, what would it be?', expression: 'smile' },
  { text: 'How do people just… talk to strangers so easily?', expression: 'frown' },
  { text: 'What song do you play when you need to feel brave?', expression: 'smile' },
  { text: 'Does missing someone ever fully stop?', expression: 'frown' },
  { text: 'What tiny habit genuinely changed your life?', expression: 'smile' },
  { text: 'How do you rest without feeling guilty about it?', expression: 'frown' },
  { text: 'What made you laugh so hard you cried?', expression: 'smile' },
  { text: 'How do I stop comparing my life to everyone else’s?', expression: 'frown' },
  { text: 'What’s something kind a stranger once did for you?', expression: 'smile' },
];

const RESIDENT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    expression: { type: 'string', enum: ['smile', 'frown'] },
  },
  required: ['text', 'expression'],
  additionalProperties: false,
};

const RESIDENT_PROMPT =
  'You write for Wonder Meadow, an anonymous kindness app where questions wander a twilight meadow until a stranger answers. ' +
  'Write ONE new question a real anonymous person might whisper — warm, human, specific, under 120 characters. ' +
  'Mix it up: sometimes light and curious (expression "smile"), sometimes tender or melancholy (expression "frown"). ' +
  'It must invite a stranger’s answer, and must not repeat or resemble the existing questions you are given.';

/* Compose one new resident question. `existing` is the list of question texts
 * already wandering, so the meadow doesn't repeat itself. */
async function residentQuestion(existing) {
  if (enabled()) {
    try {
      const q = await ask({
        system: RESIDENT_PROMPT,
        user: JSON.stringify({ existing }),
        schema: RESIDENT_SCHEMA,
        jsonHint: '{"text": "<the question>", "expression": "smile"|"frown"}',
        validate: (d) => { if (typeof d.text !== 'string' || d.text.length < 8) throw new Error('resident question too short or missing'); },
      });
      return { text: q.text.slice(0, 200), expression: q.expression === 'frown' ? 'frown' : 'smile' };
    } catch (e) {
      console.warn('meadow keeper could not compose a resident (using the pool):', e.message);
    }
  }
  const unused = RESIDENT_POOL.filter((p) => !existing.includes(p.text));
  const bag = unused.length ? unused : RESIDENT_POOL;
  return bag[Math.floor(Math.random() * bag.length)];
}

function describeProviders() {
  const parts = [];
  if (FLAZ_KEY) parts.push(`flaz.id (${FLAZ_MODEL})`);
  if (client) parts.push(`Anthropic (${MODEL})`);
  return parts.join(' → ');
}

module.exports = { screen, residentQuestion, enabled, model: describeProviders() };
