const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

// Convertit les points d'interrogation (?, ?, ...) utilisés partout dans le code existant
// vers la syntaxe $1, $2, ... attendue par PostgreSQL — évite de réécrire à la main
// chacune des 117 requêtes SQL du projet.
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// Fournit une API compatible avec celle de better-sqlite3 (prepare().get/.all/.run()),
// mais asynchrone (Promise) puisque PostgreSQL ne peut pas fonctionner de façon
// synchrone comme SQLite. Chaque appel existant doit donc être précédé de `await`.
function prepare(sql) {
  const pgSql = toPgQuery(sql);
  return {
    async get(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await pool.query(pgSql, params);
      return result.rows;
    },
    async run(...params) {
      const result = await pool.query(pgSql, params);
      return {
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount,
      };
    },
  };
}

async function exec(sql) {
  await pool.query(sql);
}

async function initSchema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      reward_text TEXT NOT NULL, points_per_euro REAL DEFAULT 1,
      points_goal INTEGER DEFAULT 100, color TEXT DEFAULT '#b45309',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY, shop_id INTEGER NOT NULL,
      name TEXT NOT NULL, points INTEGER DEFAULT 0, total_visits INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL, points_added INTEGER NOT NULL,
      scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS sessions_store (
      token TEXT PRIMARY KEY, shop_id INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      business_name TEXT NOT NULL, phone TEXT NOT NULL,
      seen INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const alterStatements = [
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS points_per_euro REAL DEFAULT 1',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_bonus_points INTEGER DEFAULT 10',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_visit TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by INTEGER',
  ];
  for (const stmt of alterStatements) {
    try { await exec(stmt); } catch (e) {}
  }
  try { await exec("UPDATE customers SET last_visit = created_at WHERE last_visit IS NULL"); } catch (e) {}
}

module.exports = { prepare, exec, pool, initSchema };
