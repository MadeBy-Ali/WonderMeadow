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
      const open = db.questions.filter((q) => !q.answered).slice(-maxOpen);
      const recent = db.questions.filter((q) => q.answered && now - q.answeredAt < recentMs);
      return [...open, ...recent].map((q) => ({
        id: q.id, text: q.text, answered: q.answered, answeredAt: q.answeredAt || null,
        color: q.color || 'm', expression: q.expression || 'smile',
      }));
    },

    async create(q) {
      if (db.questions.some((x) => x.code === q.code)) {
        throw Object.assign(new Error('duplicate code'), { dup: true });
      }
      db.questions.push({ ...q, answered: false, answeredAt: null, answers: [], closedAt: null, codeUsed: false });
      saveSoon();
    },

    async answer(id, a) {
      const q = db.questions.find((x) => x.id === id);
      if (!q) return 'notfound';
      if (q.answered) return 'conflict';
      q.answers.push(a);
      q.answered = true;
      q.answeredAt = a.createdAt;
      saveSoon();
      return 'ok';
    },

    async lookup(codeNorm) {
      const q = db.questions.find((x) => norm(x.code) === codeNorm);
      if (!q) return { status: 'notfound' };
      if (q.codeUsed) return { status: 'used' };
      if (!q.answered) return { status: 'unanswered', id: q.id, text: q.text, createdAt: q.createdAt, color: q.color || 'm' };
      q.codeUsed = true;
      saveSoon();
      return {
        status: 'answered', id: q.id, text: q.text, createdAt: q.createdAt, color: q.color || 'm',
        answers: q.answers.map((a) => ({ alias: a.alias, text: a.text, createdAt: a.createdAt })),
      };
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
        CREATE INDEX IF NOT EXISTS idx_questions_open ON questions (answered, answered_at DESC);
        CREATE INDEX IF NOT EXISTS idx_questions_open_created ON questions (answered, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
      `);
    },

    async worldList(recentMs, maxOpen) {
      const cutoff = Date.now() - recentMs;
      const { rows } = await pool.query(
        `(SELECT id, text, answered, answered_at, color, expression FROM questions
           WHERE answered = FALSE ORDER BY created_at DESC LIMIT $1)
         UNION ALL
         (SELECT id, text, answered, answered_at, color, expression FROM questions
           WHERE answered = TRUE AND answered_at > $2)`,
        [maxOpen, cutoff]
      );
      return rows.map((r) => ({
        id: r.id, text: r.text, answered: r.answered,
        answeredAt: r.answered_at === null ? null : Number(r.answered_at),
        color: r.color, expression: r.expression,
      }));
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

    // first answer wins — enforced atomically so two strangers can't both close it
    async answer(id, a) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const upd = await client.query(
          `UPDATE questions SET answered = TRUE, answered_at = $2
             WHERE id = $1 AND answered = FALSE RETURNING id`,
          [id, a.createdAt]
        );
        if (!upd.rowCount) {
          const exists = await client.query(`SELECT 1 FROM questions WHERE id = $1`, [id]);
          await client.query('ROLLBACK');
          return exists.rowCount ? 'conflict' : 'notfound';
        }
        await client.query(
          `INSERT INTO answers (question_id, alias, text, created_at) VALUES ($1, $2, $3, $4)`,
          [id, a.alias, a.text, a.createdAt]
        );
        await client.query('COMMIT');
        return 'ok';
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    // one-time code: consumed atomically, and only when it delivers an answer
    async lookup(codeNorm) {
      const { rows } = await pool.query(
        `SELECT id, text, created_at, answered, code_used, color FROM questions
           WHERE REPLACE(code, '-', '') = $1`,
        [codeNorm]
      );
      const q = rows[0];
      if (!q) return { status: 'notfound' };
      if (q.code_used) return { status: 'used' };
      if (!q.answered) return { status: 'unanswered', id: q.id, text: q.text, createdAt: Number(q.created_at), color: q.color };
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
        status: 'answered', id: q.id, text: q.text, createdAt: Number(q.created_at), color: q.color,
        answers: ans.rows.map((a) => ({ alias: a.alias, text: a.text, createdAt: Number(a.created_at) })),
      };
    },
  };
}

module.exports = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : jsonStore();
