const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'fidelypass.db')
  : path.join(__dirname, 'fidelypass.db');

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    reward_text TEXT NOT NULL, points_per_euro REAL DEFAULT 1,
    points_goal INTEGER DEFAULT 100, color TEXT DEFAULT '#b45309',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL,
    name TEXT NOT NULL, points INTEGER DEFAULT 0, total_visits INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shop_id) REFERENCES shops(id)
  );
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
    shop_id INTEGER NOT NULL, points_added INTEGER NOT NULL,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS sessions_store (
    token TEXT PRIMARY KEY, shop_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try { db.exec('ALTER TABLE shops ADD COLUMN points_per_euro REAL DEFAULT 1'); } catch(e) {}

module.exports = db;