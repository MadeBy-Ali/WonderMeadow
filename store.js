/* Wonder Meadow storage.
 * Production: PostgreSQL (set DATABASE_URL). Local dev: a JSON file in data/.
 * Both backends expose the same async API:
 *   init(), worldList(recentMs, maxOpen), create(q), answer(id, a), lookup(codeNorm)
 */
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------- JSON (dev)
function jsonStore() {
  const DATA_DIR = path.join(__dirname, 'data');
  const DB_FILE = path.join(DATA_DIR, 'db.json');
  let db = { questions: [] };
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.questions)) db = { questions: [] };
  } catch {
    /* first run */
  }
  let timer = null;
  const saveSoon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    }, 250);
  };
  // ---- question lifecycle ---------------------------------------------------
  //   open     : no answers yet
  //   ripening : at least one answer, not closed — the answer cap / time window is running
  //   closed   : closedAt is set — the wanderer ascends
  // We STORE only closedAt (a one-time event). Everything else is DERIVED so it can't
  // drift out of sync:  answer count = answers.length,  ripening started = answers[0].createdAt
  // (answers is append-only, so the first entry is always the oldest).
  const stateOf = (q) => (q.closedAt != null ? 'closed' : q.answers.length > 0 ? 'ripening' : 'open');

  // Bring a question loaded from disk (maybe written by an older version) up to the
  // current shape. Returns true if it had to change something.
  const normalize = (q) => {
    let changed = false;
    if (!Array.isArray(q.answers)) { q.answers = []; changed = true; }
    if (q.closedAt === undefined) {
      // legacy rows: "answered" used to mean "closed", at the time of the (only) answer
      q.closedAt = q.answered ? (q.answeredAt ?? q.createdAt) : null;
      changed = true;
    }

    // the old yes/no fields are gone: closedAt replaced them
    if ('answered' in q || 'answeredAt' in q) { delete q.answered; delete q.answeredAt; changed = true; }

    return changed;
  };
  // .map runs normalize on EVERY row (a bare .some would stop at the first change)
  if (db.questions.map(normalize).some(Boolean)) saveSoon();

  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

  return {
    kind: 'json file (set DATABASE_URL for PostgreSQL)',

    async init() {},

    async worldList(recentMs, maxOpen) {
      const now = Date.now();
      const live = db.questions.filter((q) => q.closedAt == null).slice(-maxOpen);                  // open + ripening
      const recent = db.questions.filter((q) => q.closedAt != null && now - q.closedAt < recentMs);  // just ascended
      return [...live, ...recent].map((q) => ({
        id: q.id, text: q.text,
        answerCount: q.answers.length,
        closedAt: q.closedAt,
        // compatibility for the current front end: "answered" now means "closed (ascends)"
        answered: q.closedAt != null, answeredAt: q.closedAt,
        color: q.color || 'm', expression: q.expression || 'smile',
      }));
    },

    async create(q) {
      if (db.questions.some((x) => x.code === q.code)) {
        throw Object.assign(new Error('duplicate code'), { dup: true });
      }
      db.questions.push({ ...q, answers: [], closedAt: null, codeUsed: false });
      saveSoon();
    },

    // Add an answer to a question.
    //   a     = { alias, text, createdAt, authorHash }   (a.createdAt is "now")
    //   rules = { maxAnswers, windowMs }                  (from server.js)
    async answer(id, a, rules) {
      const q = db.questions.find((x) => x.id === id);
      if (!q) return { status: 'notfound' };

      // already closed: nothing more is accepted
      if (q.closedAt != null) return { status: 'closed' };

      // window already over (even if the sweeper hasn't noticed yet): close it now
      if (q.answers.length > 0 && a.createdAt >= q.answers[0].createdAt + rules.windowMs) {
        q.closedAt = a.createdAt;
        saveSoon();
        return { status: 'closed' };
      }

      // the same person can't answer twice
      if (a.authorHash && q.answers.some((x) => x.authorHash === a.authorHash)) {
        return { status: 'duplicate' };
      }

      q.answers.push(a);

      // did that answer fill the last slot?
      if (q.answers.length >= rules.maxAnswers) q.closedAt = a.createdAt;

      saveSoon();
      return { status: 'ok', count: q.answers.length, closed: q.closedAt != null };
    },

    // rules = { maxAnswers, windowMs };  `now` can be injected so tests don't have to wait
    async lookup(codeNorm, rules, now = Date.now()) {
      const q = db.questions.find((x) => norm(x.code) === codeNorm);
      if (!q) return { status: 'notfound' };
      if (q.codeUsed) return { status: 'used' };

      // window over but the sweeper hasn't run yet? close it now
      if (stateOf(q) === 'ripening' && now >= q.answers[0].createdAt + rules.windowMs) {
        q.closedAt = now;
        saveSoon();
      }

      const state = stateOf(q);
      if (state === 'open') {
        return { status: 'unanswered', id: q.id, text: q.text, createdAt: q.createdAt, color: q.color || 'm' };
      }
      if (state === 'ripening') {
        // answers stay hidden until the question closes; the code is NOT used up
        return {
          status: 'ripening', id: q.id, text: q.text, createdAt: q.createdAt, color: q.color || 'm',
          count: q.answers.length,
          closesAt: q.answers[0].createdAt + rules.windowMs,
        };
      }

      // closed: deliver everything, then retire the code
      q.codeUsed = true;
      saveSoon();
      return {
        status: 'answered', id: q.id, text: q.text, createdAt: q.createdAt, color: q.color || 'm',
        answers: q.answers.map((a) => ({ alias: a.alias, text: a.text, createdAt: a.createdAt })),
      };
    },

    // Called by the sweeper: close every ripening question whose window is over.
    // Returns how many it closed.
    async closeExpired(rules, now = Date.now()) {
      let closed = 0;
      for (const q of db.questions) {
        if (stateOf(q) === 'ripening' && now >= q.answers[0].createdAt + rules.windowMs) {
          q.closedAt = now;
          closed++;
        }
      }
      if (closed) saveSoon();
      return closed;
    },
  };
}

// ------------------------------------------------------- PostgreSQL (prod)
function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 10 });

  return {
    kind: 'postgresql',

    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS questions (
          id UUID PRIMARY KEY,
          text TEXT NOT NULL,
          code TEXT NOT NULL UNIQUE,
          created_at BIGINT NOT NULL,
          answered BOOLEAN NOT NULL DEFAULT FALSE,
          answered_at BIGINT,
          code_used BOOLEAN NOT NULL DEFAULT FALSE,
          color TEXT NOT NULL DEFAULT 'm',
          expression TEXT NOT NULL DEFAULT 'smile'
        );
        ALTER TABLE questions ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'm';
        ALTER TABLE questions ADD COLUMN IF NOT EXISTS expression TEXT NOT NULL DEFAULT 'smile';
        CREATE TABLE IF NOT EXISTS answers (
          id BIGSERIAL PRIMARY KEY,
          question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
          alias TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );


        -- ripening columns (idempotent: safe to run on every boot)
        ALTER TABLE questions ADD COLUMN IF NOT EXISTS closed_at BIGINT;
        ALTER TABLE questions ADD COLUMN IF NOT EXISTS first_answer_at BIGINT;
        ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_count INT NOT NULL DEFAULT 0;
        ALTER TABLE answers ADD COLUMN IF NOT EXISTS author_hash TEXT;

        -- backfill rows written by the old "first answer wins" version.
        -- the guards make both statements no-ops once the rows are converted.
        UPDATE questions q
           SET answer_count = s.cnt, first_answer_at = s.first_at
          FROM (SELECT question_id, COUNT(*) AS cnt, MIN(created_at) AS first_at
                  FROM answers GROUP BY question_id) s
         WHERE q.id = s.question_id AND q.answer_count = 0;
        UPDATE questions SET closed_at = COALESCE(answered_at, created_at)
         WHERE answered = TRUE AND closed_at IS NULL;

        -- indexes: the old (answered, ...) ones are replaced by partial indexes on the new lifecycle
        DROP INDEX IF EXISTS idx_questions_open;
        DROP INDEX IF EXISTS idx_questions_open_created;
        CREATE INDEX IF NOT EXISTS idx_questions_live ON questions (created_at DESC) WHERE closed_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_questions_recently_closed ON questions (closed_at) WHERE closed_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_questions_ripening ON questions (first_answer_at) WHERE closed_at IS NULL AND first_answer_at IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_answers_author ON answers (question_id, author_hash) WHERE author_hash IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
      `);
    },

    async worldList(recentMs, maxOpen) {
      const cutoff = Date.now() - recentMs;
      const { rows } = await pool.query(
        `(SELECT id, text, answer_count, closed_at, color, expression FROM questions
           WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT $1)        -- open + ripening
         UNION ALL
         (SELECT id, text, answer_count, closed_at, color, expression FROM questions
           WHERE closed_at IS NOT NULL AND closed_at > $2)`,                  // just ascended
        [maxOpen, cutoff]
      );
      return rows.map((r) => {
        const closedAt = r.closed_at === null ? null : Number(r.closed_at);
        return {
          id: r.id, text: r.text,
          answerCount: r.answer_count,
          closedAt,
          // compatibility for the current front end: "answered" now means "closed (ascends)"
          answered: closedAt !== null, answeredAt: closedAt,
          color: r.color, expression: r.expression,
        };
      });
    },

    async create(q) {
      try {
        await pool.query(
          `INSERT INTO questions (id, text, code, created_at, color, expression) VALUES ($1, $2, $3, $4, $5, $6)`,
          [q.id, q.text, q.code, q.createdAt, q.color || 'm', q.expression || 'smile']
        );
      } catch (e) {
        if (e.code === '23505') throw Object.assign(new Error('duplicate code'), { dup: true });
        throw e;
      }
    },

    // Add an answer. Same rules as the JSON store, but safe under concurrency: the question's
    // row is locked (FOR UPDATE) until COMMIT/ROLLBACK, so simultaneous answers run one at a time.
    //   a = { alias, text, createdAt, authorHash }     rules = { maxAnswers, windowMs }
    async answer(id, a, rules) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1) lock the question's row; anyone else answering it waits here until we finish
        const found = await client.query(
          `SELECT closed_at, first_answer_at FROM questions WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!found.rowCount) { await client.query('ROLLBACK'); return { status: 'notfound' }; }
        const q = found.rows[0];

        // 2) already closed: nothing more is accepted
        if (q.closed_at !== null) { await client.query('ROLLBACK'); return { status: 'closed' }; }

        // 3) window already over (even if the sweeper hasn't run): close it now and KEEP that change
        if (q.first_answer_at !== null && a.createdAt >= Number(q.first_answer_at) + rules.windowMs) {
          await client.query(`UPDATE questions SET closed_at = $2::bigint WHERE id = $1`, [id, a.createdAt]);
          await client.query('COMMIT');
          return { status: 'closed' };
        }

        // 4) insert the answer; the unique index refuses a second answer from the same author
        const ins = await client.query(
          `INSERT INTO answers (question_id, alias, text, created_at, author_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (question_id, author_hash) WHERE author_hash IS NOT NULL DO NOTHING
           RETURNING id`,
          [id, a.alias, a.text, a.createdAt, a.authorHash ?? null]
        );
        if (!ins.rowCount) { await client.query('ROLLBACK'); return { status: 'duplicate' }; }

        // 5) count it, stamp first_answer_at on the very first answer, close if the cap is reached
        const upd = await client.query(
          `UPDATE questions
              SET answer_count    = answer_count + 1,
                  first_answer_at = COALESCE(first_answer_at, $2::bigint),
                  closed_at       = CASE WHEN answer_count + 1 >= $3::int THEN $2::bigint ELSE NULL END
            WHERE id = $1
            RETURNING answer_count, closed_at`,
          [id, a.createdAt, rules.maxAnswers]
        );
        await client.query('COMMIT');
        return { status: 'ok', count: upd.rows[0].answer_count, closed: upd.rows[0].closed_at !== null };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    // rules = { maxAnswers, windowMs };  `now` can be injected so tests don't have to wait
    async lookup(codeNorm, rules, now = Date.now()) {
      const { rows } = await pool.query(
        `SELECT id, text, created_at, code_used, color, answer_count, first_answer_at, closed_at
           FROM questions WHERE REPLACE(code, '-', '') = $1`,
        [codeNorm]
      );
      const q = rows[0];
      if (!q) return { status: 'notfound' };
      if (q.code_used) return { status: 'used' };

      const count = q.answer_count;
      const firstAt = q.first_answer_at === null ? null : Number(q.first_answer_at);
      let closed = q.closed_at !== null;

      // window over but the sweeper hasn't run yet? close it now (a no-op if someone else just did)
      if (!closed && firstAt !== null && now >= firstAt + rules.windowMs) {
        await pool.query(`UPDATE questions SET closed_at = $2::bigint WHERE id = $1 AND closed_at IS NULL`, [q.id, now]);
        closed = true;
      }

      const base = { id: q.id, text: q.text, createdAt: Number(q.created_at), color: q.color };
      if (!closed && count === 0) return { status: 'unanswered', ...base };
      if (!closed) {
        // answers stay hidden until the question closes; the code is NOT used up
        return { status: 'ripening', ...base, count, closesAt: firstAt + rules.windowMs };
      }

      // closed: retire the code atomically, then deliver everything
      const upd = await pool.query(
        `UPDATE questions SET code_used = TRUE WHERE id = $1 AND code_used = FALSE RETURNING id`,
        [q.id]
      );
      if (!upd.rowCount) return { status: 'used' };
      const ans = await pool.query(
        `SELECT alias, text, created_at FROM answers WHERE question_id = $1 ORDER BY created_at ASC`,
        [q.id]
      );
      return {
        status: 'answered', ...base,
        answers: ans.rows.map((a) => ({ alias: a.alias, text: a.text, createdAt: Number(a.created_at) })),
      };
    },

    // Called by the sweeper: close every ripening question whose window is over.
    // Returns how many it closed. (first_answer_at is kept bare on one side so the index is usable.)
    async closeExpired(rules, now = Date.now()) {
      const r = await pool.query(
        `UPDATE questions SET closed_at = $1::bigint
          WHERE closed_at IS NULL AND first_answer_at IS NOT NULL
            AND first_answer_at <= $1::bigint - $2::bigint`,
        [now, rules.windowMs]
      );
      return r.rowCount;
    },

  };
}

module.exports = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : jsonStore();
