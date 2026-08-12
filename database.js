const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  max: 20,                      // connexions simultanées max — large marge pour plusieurs boutiques actives en même temps
  idleTimeoutMillis: 30000,     // libère les connexions inutilisées après 30s
  connectionTimeoutMillis: 10000, // évite un blocage indéfini si la base est momentanément injoignable
});

// Sans ce listener, une coupure réseau ou un redémarrage de la base ferait planter
// TOUT le serveur Node (comportement par défaut de pg sur un client idle en erreur).
// On log l'erreur et on laisse le pool se reconnecter tout seul au prochain appel.
pool.on('error', (err) => {
  console.error('Erreur inattendue sur une connexion PostgreSQL inactive :', err.message);
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
    CREATE TABLE IF NOT EXISTS admin_messages (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL, body TEXT NOT NULL,
      target_shop_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reward_tiers (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      threshold_points INTEGER NOT NULL,
      reward_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
    CREATE TABLE IF NOT EXISTS shop_availability (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      appointment_time TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'confirmed',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES shops(id),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
    CREATE TABLE IF NOT EXISTS staff_members (
      id SERIAL PRIMARY KEY,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shop_id) REFERENCES shops(id)
    );
    CREATE TABLE IF NOT EXISTS staff_availability (
      id SERIAL PRIMARY KEY,
      staff_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      FOREIGN KEY (staff_id) REFERENCES staff_members(id)
    );
  `);

  const alterStatements = [
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS points_per_euro REAL DEFAULT 1',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS referral_bonus_points INTEGER DEFAULT 10',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_visit TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS referred_by INTEGER',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_message_read_at TIMESTAMP',
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS reward_cycles_completed INTEGER DEFAULT 0',
    'ALTER TABLE scans ADD COLUMN IF NOT EXISTS amount_paid REAL',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_digest_sent_at TIMESTAMP',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS risk_threshold_days INTEGER DEFAULT 30',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS lost_threshold_days INTEGER DEFAULT 60',
    "ALTER TABLE admin_messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'admin'",
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS booking_enabled INTEGER DEFAULT 0',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS booking_slot_minutes INTEGER DEFAULT 30',
    'ALTER TABLE shops ADD COLUMN IF NOT EXISTS last_appointment_seen_at TIMESTAMP',
    'ALTER TABLE scans ADD COLUMN IF NOT EXISTS is_manual INTEGER DEFAULT 0',
    'ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_id INTEGER',
    'ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_id INTEGER',
  ];
  for (const stmt of alterStatements) {
    try { await exec(stmt); } catch (e) {}
  }
  try { await exec("UPDATE customers SET last_visit = created_at WHERE last_visit IS NULL"); } catch (e) {}

  // Index de performance — indispensables dès que le volume de boutiques/clients/scans grandit,
  // sinon chaque requête (liste clients, scan, stats, login) fait un parcours complet de table.
  // CREATE INDEX IF NOT EXISTS est sûr à rejouer à chaque démarrage, aucun impact sur les données.
  const indexStatements = [
    'CREATE INDEX IF NOT EXISTS idx_customers_shop_id ON customers(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_customers_referred_by ON customers(referred_by)',
    'CREATE INDEX IF NOT EXISTS idx_scans_shop_id ON scans(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_scans_customer_id ON scans(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_scans_shop_scanned_at ON scans(shop_id, scanned_at)',
    'CREATE INDEX IF NOT EXISTS idx_reward_tiers_shop_id ON reward_tiers(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_customer_id ON push_subscriptions(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_admin_messages_target_shop_id ON admin_messages(target_shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_shops_slug ON shops(slug)',
    'CREATE INDEX IF NOT EXISTS idx_shops_email ON shops(email)',
    'CREATE INDEX IF NOT EXISTS idx_shop_availability_shop_id ON shop_availability(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_shop_id ON appointments(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_customer_id ON appointments(customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_appointments_time ON appointments(shop_id, appointment_time)',
    'CREATE INDEX IF NOT EXISTS idx_services_shop_id ON services(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_staff_members_shop_id ON staff_members(shop_id)',
    'CREATE INDEX IF NOT EXISTS idx_staff_availability_staff_id ON staff_availability(staff_id)',
  ];
  for (const stmt of indexStatements) {
    try { await exec(stmt); } catch (e) {}
  }
}

module.exports = { prepare, exec, pool, initSchema };
