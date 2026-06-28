const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/test', (req, res) => res.json({ message: 'FidélyPass fonctionne !' }));

app.post('/api/shops', (req, res) => {
  const { name, slug, password, reward_text, points_per_visit, points_goal, color } = req.body;
  try {
    const stmt = db.prepare(`INSERT INTO shops (name, slug, password, reward_text, points_per_visit, points_goal, color) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(name, slug, password, reward_text, points_per_visit, points_goal, color);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/shops', (req, res) => res.json(db.prepare('SELECT * FROM shops').all()));

app.post('/api/shops/login', (req, res) => {
  const { slug, password } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE slug = ? AND password = ?').get(slug, password);
  if (shop) res.json({ success: true, shop });
  else res.status(401).json({ success: false, error: 'Identifiants incorrects' });
});

app.get('/api/shops/:id/stats', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  const customers = db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ?').get(req.params.id);
  const scans = db.prepare('SELECT COUNT(*) as count FROM scans WHERE shop_id = ?').get(req.params.id);
  const rewards = db.prepare("SELECT COUNT(*) as count FROM scans WHERE shop_id = ? AND points_added = 0").get(req.params.id);
  res.json({ shop, total_customers: customers.count, total_scans: scans.count, total_rewards: rewards.count });
});

app.post('/api/customers', (req, res) => {
  const { shop_id, name } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO customers (shop_id, name) VALUES (?, ?)');
    const result = stmt.run(shop_id, name);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (customer) res.json(customer);
  else res.status(404).json({ error: 'Client introuvable' });
});

app.post('/api/scan', (req, res) => {
  const { customer_id, shop_id } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(customer_id, shop_id);
  if (!shop || !customer) return res.status(404).json({ success: false, error: 'Introuvable' });
  const newPoints = customer.points + shop.points_per_visit;
  const rewardUnlocked = newPoints >= shop.points_goal;
  const finalPoints = rewardUnlocked ? 0 : newPoints;
  db.prepare('UPDATE customers SET points = ?, total_visits = total_visits + 1 WHERE id = ?').run(finalPoints, customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(customer_id, shop_id, shop.points_per_visit);
  res.json({ success: true, customer_name: customer.name, points_before: customer.points, points_after: finalPoints, points_added: shop.points_per_visit, reward_unlocked: rewardUnlocked, reward_text: shop.reward_text, points_goal: shop.points_goal });
});

app.get('/api/shops/:shop_id/customers', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE shop_id = ? ORDER BY points DESC').all(req.params.shop_id);
  res.json(customers);
});

app.listen(PORT, () => console.log(`FidélyPass tourne sur http://localhost:${PORT}`));
