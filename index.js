const express = require('express');
const QRCode = require('qrcode');
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
  const { name, slug, password, reward_text, points_per_euro, points_goal, color } = req.body;
  try {
    const stmt = db.prepare(`INSERT INTO shops (name, slug, password, reward_text, points_per_euro, points_goal, color) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const result = stmt.run(name, slug, password, reward_text, points_per_euro || 1, points_goal, color);
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
  const { customer_id, shop_id, amount } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(customer_id, shop_id);
  if (!shop || !customer) return res.status(404).json({ success: false, error: 'Introuvable' });
  const pointsPerEuro = shop.points_per_euro || 1;
  const pointsEarned = Math.floor((amount || 0) * pointsPerEuro);
  const newPoints = customer.points + pointsEarned;
  const rewardUnlocked = newPoints >= shop.points_goal;
  db.prepare('UPDATE customers SET points = ?, total_visits = total_visits + 1 WHERE id = ?').run(newPoints, customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(customer_id, shop_id, pointsEarned);
  res.json({ success: true, customer_name: customer.name, points_before: customer.points, points_after: newPoints, points_added: pointsEarned, amount_paid: amount, reward_unlocked: rewardUnlocked, reward_text: shop.reward_text, points_goal: shop.points_goal });
});

app.post('/api/reward/:customer_id', (req, res) => {
  const { shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.customer_id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  db.prepare('UPDATE customers SET points = 0 WHERE id = ?').run(req.params.customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(req.params.customer_id, shop_id, 0);
  res.json({ success: true });
});

app.get('/api/shops/:shop_id/customers', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE shop_id = ? ORDER BY points DESC').all(req.params.shop_id);
  res.json(customers);
});

app.get('/api/customers/:id/qr', async (req, res) => {
  const url = 'fidelypass:customer:' + req.params.id;
  const qr = await QRCode.toDataURL(url);
  res.json({ qr });
});

app.get('/api/customers/:id/wallet', async (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Client introuvable' });
    const { createWalletPass } = require('./wallet');
    const url = await createWalletPass(customer);
    res.json({ url });
  } catch (err) {
    console.error('Wallet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/card/:id', (req, res) => {
  const id = req.params.id;
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ma carte FidélyPass</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:340px}h1{font-size:22px;font-weight:800;margin-bottom:4px}p{color:#6b7280;font-size:13px;margin-bottom:24px}#qr{width:200px;height:200px;border-radius:12px}.id{margin-top:16px;font-size:13px;color:#9ca3af}#wallet-btn{margin-top:20px}</style></head><body><div class="card"><h1>🎯 FidélyPass</h1><p>Présentez ce QR code au gérant</p><img id="qr" src="" alt="QR Code"><div class="id">Carte n°${id}</div><div id="wallet-btn"></div></div><script>fetch("/api/customers/${id}/qr").then(r=>r.json()).then(d=>document.getElementById("qr").src=d.qr);fetch("/api/customers/${id}/wallet").then(r=>r.json()).then(d=>{if(d.url){document.getElementById("wallet-btn").innerHTML='<a href="'+d.url+'" target="_blank"><img src="https://pay.google.com/about/static/sample-assets/pay-with-google/add-to-wallet-button.svg" style="width:200px;margin-top:8px" alt="Ajouter à Google Wallet"></a>';}});<\/script></body></html>`);
});

app.put('/api/shops/:id', (req, res) => {
  const { name, slug, password, reward_text, points_per_euro, points_goal, color } = req.body;
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    const newPassword = password && password.trim() !== '' ? password : shop.password;
    db.prepare(`UPDATE shops SET name=?, slug=?, password=?, reward_text=?, points_per_euro=?, points_goal=?, color=? WHERE id=?`)
      .run(name, slug, newPassword, reward_text, points_per_euro || 1, points_goal, color, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/api/shops/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM scans WHERE shop_id = ?').run(req.params.id);
    db.prepare('DELETE FROM customers WHERE shop_id = ?').run(req.params.id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/join/:slug', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(req.params.slug);
  if (!shop) return res.status(404).send('Boutique introuvable');
  const id = shop.id;
  const name = shop.name;
  const color = shop.color;
  const goal = shop.points_goal;
  const reward = shop.reward_text;
  const initials = shop.name.slice(0,2).toUpperCase();
  res.send('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Rejoindre ' + name + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:380px}.logo{width:64px;height:64px;border-radius:16px;background:' + color + ';display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:white;margin:0 auto 16px}h1{font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:4px}p{color:#6b7280;font-size:14px;margin-bottom:24px}.info{background:#f8fafc;border-radius:12px;padding:14px;margin-bottom:24px;font-size:13px;color:#374151}input{width:100%;padding:16px;border:2px solid #e5e7eb;border-radius:14px;font-size:18px;text-align:center;font-weight:700;color:#1a1a1a;outline:none;margin-bottom:12px}input:focus{border-color:#3b82f6}button{width:100%;padding:16px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;font-size:17px;font-weight:700;border:none;cursor:pointer}.error{color:#ef4444;font-size:13px;margin-bottom:12px;display:none}</style></head><body><div class="card"><div class="logo">' + initials + '</div><h1>' + name + '</h1><p>Créez votre carte de fidélité gratuite</p><div class="info">🎁 Objectif : <strong>' + goal + ' points</strong><br>Récompense : <strong>' + reward + '</strong></div><div class="error" id="e">Veuillez entrer votre prénom</div><input type="text" id="n" placeholder="Votre prénom"><button onclick="j()">Obtenir ma carte 🎯</button></div><script>async function j(){const n=document.getElementById("n").value.trim();if(!n){document.getElementById("e").style.display="block";return;}const r=await fetch("/api/customers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shop_id:' + id + ',name:n})});const d=await r.json();if(d.success)window.location.href="/card/"+d.id;}document.getElementById("n").addEventListener("keypress",e=>{if(e.key==="Enter")j();});<\/script></body></html>');
});

app.get('/', (req, res) => {
  res.redirect('/gerant.html');
});

const ADMIN_PASSWORD = 'fidelypass2024';
app.get('/admin', (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64')) {
    res.set('WWW-Authenticate', 'Basic realm="FidélyPass Admin"');
    return res.status(401).send('Accès refusé');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => console.log('FidélyPass tourne sur http://localhost:' + PORT));