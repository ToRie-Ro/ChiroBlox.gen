const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      secret_ciphertext TEXT NOT NULL,
      secret_iv TEXT NOT NULL,
      secret_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'claimed', 'disabled')),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      claimed_by_telegram_id TEXT,
      claimed_by_username TEXT
    );

    CREATE INDEX IF NOT EXISTS accounts_status_idx ON accounts(status);
    CREATE INDEX IF NOT EXISTS accounts_created_idx ON accounts(created_at DESC);

    CREATE TABLE IF NOT EXISTS claims (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL,
      telegram_username TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS claims_claimed_at_idx ON claims(claimed_at DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
  `);
}

async function ensureAdmin(username, passwordHash) {
  await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
    [username, passwordHash]
  );
}

async function createAccount({ username, encrypted, metadata = {} }) {
  const result = await query(
    `INSERT INTO accounts (username, secret_ciphertext, secret_iv, secret_tag, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, username, status, metadata, created_at`,
    [username, encrypted.ciphertext, encrypted.iv, encrypted.tag, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

async function createAccountsBulk(records) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = [];
    for (const record of records) {
      const result = await client.query(
        `INSERT INTO accounts (username, secret_ciphertext, secret_iv, secret_tag, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, username, status, metadata, created_at`,
        [record.username, record.encrypted.ciphertext, record.encrypted.iv, record.encrypted.tag, JSON.stringify(record.metadata || {})]
      );
      rows.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listAccounts({ status = 'all', limit = 100, offset = 0 }) {
  const params = [];
  let where = '';
  if (['available', 'claimed', 'disabled'].includes(status)) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const limitIndex = params.length;
  params.push(Math.max(Number(offset) || 0, 0));
  const offsetIndex = params.length;

  const result = await query(
    `SELECT id, username, status, metadata, created_at, claimed_at, claimed_by_telegram_id, claimed_by_username
     FROM accounts ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params
  );
  return result.rows;
}

async function getStats() {
  const result = await query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'available')::int AS available,
      COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
      COUNT(*) FILTER (WHERE status = 'disabled')::int AS disabled,
      COUNT(*)::int AS total
    FROM accounts
  `);
  const claims = await query(`SELECT COUNT(*)::int AS claims_today FROM claims WHERE claimed_at >= CURRENT_DATE`);
  return { ...result.rows[0], ...claims.rows[0] };
}

async function getActivity(limit = 50) {
  const result = await query(
    `SELECT id, action, actor_type, actor_id, details, created_at
     FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows;
}

async function addAudit(action, actorType, actorId, details = {}) {
  await query(
    `INSERT INTO audit_logs (action, actor_type, actor_id, details) VALUES ($1, $2, $3, $4::jsonb)`,
    [action, actorType, actorId == null ? null : String(actorId), JSON.stringify(details)]
  );
}

async function getAdmin(username) {
  const result = await query(`SELECT id, username, password_hash FROM admins WHERE username = $1`, [username]);
  return result.rows[0] || null;
}

async function claimRandomAccount({ telegramUserId, telegramUsername }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pick = await client.query(`
      SELECT * FROM accounts
      WHERE status = 'available'
      ORDER BY random()
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    if (!pick.rows.length) {
      await client.query('COMMIT');
      return null;
    }

    const account = pick.rows[0];
    const updated = await client.query(`
      UPDATE accounts
      SET status = 'claimed', claimed_at = NOW(), claimed_by_telegram_id = $2, claimed_by_username = $3
      WHERE id = $1 AND status = 'available'
      RETURNING id, username, secret_ciphertext, secret_iv, secret_tag, claimed_at
    `, [account.id, String(telegramUserId), telegramUsername || null]);

    if (!updated.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }

    const claimed = updated.rows[0];
    await client.query(
      `INSERT INTO claims (account_id, telegram_user_id, telegram_username) VALUES ($1, $2, $3)`,
      [claimed.id, String(telegramUserId), telegramUsername || null]
    );
    await client.query(
      `INSERT INTO audit_logs (action, actor_type, actor_id, details) VALUES ($1, $2, $3, $4::jsonb)`,
      ['account_claimed', 'telegram', String(telegramUserId), JSON.stringify({ accountId: claimed.id, username: claimed.username })]
    );
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function disableAccount(id) {
  const result = await query(`UPDATE accounts SET status = 'disabled' WHERE id = $1 AND status <> 'claimed' RETURNING id, username, status`, [id]);
  return result.rows[0] || null;
}

async function releaseClaim(id) {
  const result = await query(`
    UPDATE accounts
    SET status = 'available', claimed_at = NULL, claimed_by_telegram_id = NULL, claimed_by_username = NULL
    WHERE id = $1 AND status = 'claimed'
    RETURNING id, username, status
  `, [id]);
  return result.rows[0] || null;
}

module.exports = {
  pool,
  query,
  migrate,
  ensureAdmin,
  createAccount,
  createAccountsBulk,
  listAccounts,
  getStats,
  getActivity,
  addAudit,
  getAdmin,
  claimRandomAccount,
  disableAccount,
  releaseClaim
};
