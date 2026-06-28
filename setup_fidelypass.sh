#!/bin/bash
echo "🚀 Création de FidélyPass..."

# Créer les fichiers
mkdir -p public

# index.js
cat > index.js << 'EOF'
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
EOF

# database.js
cat > database.js << 'EOF'
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'fidelypass.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    reward_text TEXT NOT NULL, points_per_visit INTEGER DEFAULT 10,
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
`);
module.exports = db;
EOF

# public/index.html — Dashboard Admin
cat > public/index.html << 'EOF'
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FidélyPass — Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;color:#f1f5f9;min-height:100vh}
.header{background:#1e293b;padding:16px 32px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155}
.logo{font-size:22px;font-weight:900;color:#3b82f6}
.nav a{color:#94a3b8;text-decoration:none;margin-left:24px;font-size:14px}
.nav a:hover{color:#f1f5f9}
.container{max-width:1100px;margin:0 auto;padding:32px 24px}
.page-title{font-size:28px;font-weight:800;margin-bottom:8px}
.page-sub{color:#64748b;font-size:14px;margin-bottom:32px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
.stat{background:#1e293b;border-radius:12px;padding:20px}
.stat-val{font-size:28px;font-weight:800;color:#3b82f6}
.stat-label{font-size:12px;color:#64748b;margin-top:4px}
.card{background:#1e293b;border-radius:12px;padding:24px;margin-bottom:24px}
.card-title{font-size:16px;font-weight:700;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
.btn{padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}
.btn-primary{background:#3b82f6;color:white}
.btn-primary:hover{background:#2563eb}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group label{font-size:12px;color:#94a3b8;font-weight:600}
.form-group input{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 12px;color:#f1f5f9;font-size:14px}
.form-group input:focus{outline:none;border-color:#3b82f6}
.form-full{grid-column:1/-1}
.shops-list{display:flex;flex-direction:column;gap:12px}
.shop-item{background:#0f172a;border-radius:10px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;border:1px solid #1e293b}
.shop-name{font-weight:700;font-size:15px}
.shop-meta{font-size:12px;color:#64748b;margin-top:4px}
.badge{padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#dcfce7;color:#166534}
.empty{text-align:center;color:#64748b;padding:40px}
.msg{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:14px;display:none}
.success{background:#dcfce7;color:#166534}
.error-msg{background:#fee2e2;color:#991b1b}
.shop-actions{display:flex;gap:8px;align-items:center}
.btn-sm{padding:6px 12px;font-size:11px;border-radius:6px;cursor:pointer;border:none;font-weight:600}
.btn-view{background:#3b82f6;color:white}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🎯 FidélyPass</div>
  <nav class="nav">
    <a href="/">Dashboard</a>
    <a href="/gerant.html">Vue gérant</a>
  </nav>
</div>
<div class="container">
  <div class="page-title">Dashboard Admin</div>
  <div class="page-sub">Gérez tous vos clients depuis ici — Bonjour Walyd 👋</div>
  <div class="stats">
    <div class="stat"><div class="stat-val" id="total-shops">0</div><div class="stat-label">Boutiques actives</div></div>
    <div class="stat"><div class="stat-val" id="total-customers">-</div><div class="stat-label">Clients totaux</div></div>
    <div class="stat"><div class="stat-val" id="total-scans">-</div><div class="stat-label">Scans total</div></div>
    <div class="stat"><div class="stat-val" id="revenue">0€</div><div class="stat-label">Revenus mensuels</div></div>
  </div>
  <div class="card">
    <div class="card-title">➕ Ajouter un nouveau client</div>
    <div class="msg success" id="success-msg">✅ Boutique créée avec succès !</div>
    <div class="msg error-msg" id="error-msg"></div>
    <div class="form-grid">
      <div class="form-group"><label>Nom de la boutique</label><input type="text" id="name" placeholder="Ex: Boulangerie Martin"></div>
      <div class="form-group"><label>Identifiant unique</label><input type="text" id="slug" placeholder="Ex: boulangerie-martin"></div>
      <div class="form-group"><label>Mot de passe gérant</label><input type="password" id="password" placeholder="Mot de passe"></div>
      <div class="form-group"><label>Points par visite</label><input type="number" id="points_per_visit" value="10"></div>
      <div class="form-group"><label>Objectif points</label><input type="number" id="points_goal" value="100"></div>
      <div class="form-group"><label>Couleur carte</label><input type="color" id="color" value="#b45309"></div>
      <div class="form-group form-full"><label>Récompense offerte</label><input type="text" id="reward_text" placeholder="Ex: 1 sandwich offert"></div>
      <div class="form-full"><button class="btn btn-primary" onclick="createShop()">Créer la boutique</button></div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">🏪 Mes clients <span id="shops-count" style="font-size:13px;color:#64748b"></span></div>
    <div class="shops-list" id="shops-list"><div class="empty">Aucune boutique pour l'instant</div></div>
  </div>
</div>
<script>
async function loadShops(){
  const res=await fetch('/api/shops');
  const shops=await res.json();
  document.getElementById('total-shops').textContent=shops.length;
  document.getElementById('revenue').textContent=(shops.length*29)+'€';
  document.getElementById('shops-count').textContent=shops.length+' boutique(s)';
  const list=document.getElementById('shops-list');
  if(!shops.length){list.innerHTML='<div class="empty">Aucune boutique pour l\'instant</div>';return;}
  list.innerHTML=shops.map(s=>`
    <div class="shop-item">
      <div>
        <div class="shop-name">${s.name}</div>
        <div class="shop-meta">Slug: ${s.slug} · ${s.points_per_visit} pts/visite · Objectif: ${s.points_goal} pts · 🎁 ${s.reward_text}</div>
      </div>
      <div class="shop-actions">
        <span class="badge">Actif</span>
        <button class="btn-sm btn-view" onclick="window.open('/gerant.html?shop=${s.slug}','_blank')">Vue gérant</button>
      </div>
    </div>
  `).join('');
}
async function createShop(){
  const data={name:document.getElementById('name').value,slug:document.getElementById('slug').value,password:document.getElementById('password').value,points_per_visit:parseInt(document.getElementById('points_per_visit').value),points_goal:parseInt(document.getElementById('points_goal').value),color:document.getElementById('color').value,reward_text:document.getElementById('reward_text').value};
  const res=await fetch('/api/shops',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await res.json();
  if(result.success){
    document.getElementById('success-msg').style.display='block';
    setTimeout(()=>document.getElementById('success-msg').style.display='none',3000);
    document.getElementById('name').value='';document.getElementById('slug').value='';document.getElementById('password').value='';document.getElementById('reward_text').value='';
    loadShops();
  }else{const err=document.getElementById('error-msg');err.textContent='❌ '+result.error;err.style.display='block';}
}
loadShops();
</script>
</body>
</html>
EOF

# public/gerant.html — Interface gérant
cat > public/gerant.html << 'EOF'
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FidélyPass — Gérant</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f2f2f7;font-family:-apple-system,'SF Pro Display',Arial,sans-serif;min-height:100vh}
.header{background:white;padding:14px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:10}
.shop-logo{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;color:white;font-size:14px}
.shop-info h2{font-size:15px;font-weight:700;color:#1a1a1a}
.shop-info p{font-size:11px;color:#9ca3af}
.container{max-width:480px;margin:0 auto;padding:20px 16px}

/* LOGIN */
#login-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;gap:16px}
.login-logo{font-size:48px;margin-bottom:8px}
.login-title{font-size:24px;font-weight:800;color:#1a1a1a}
.login-sub{font-size:14px;color:#6b7280;text-align:center}
.input{width:100%;padding:14px 16px;border:1.5px solid #e5e7eb;border-radius:12px;font-size:15px;background:white;color:#1a1a1a;outline:none}
.input:focus{border-color:#3b82f6}
.btn-login{width:100%;padding:16px;border-radius:14px;background:#3b82f6;color:white;font-size:16px;font-weight:700;border:none;cursor:pointer}
.btn-login:hover{background:#2563eb}
.login-error{color:#ef4444;font-size:13px;display:none}

/* SCAN */
#scan-screen{display:none}
.stats-mini{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.stat-mini{background:white;border-radius:12px;padding:14px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.stat-mini-val{font-size:22px;font-weight:800;color:#1a1a1a}
.stat-mini-label{font-size:10px;color:#9ca3af;margin-top:2px}
.scan-card{background:white;border-radius:20px;padding:28px 24px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08);margin-bottom:20px}
.scan-icon{width:90px;height:90px;border-radius:22px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);display:flex;align-items:center;justify-content:center;font-size:40px;margin:0 auto 16px;box-shadow:0 6px 20px rgba(59,130,246,0.35)}
.scan-title{font-size:20px;font-weight:800;color:#1a1a1a;margin-bottom:8px}
.scan-sub{font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.5}
.btn-scan{width:100%;padding:18px;border-radius:16px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;font-size:17px;font-weight:700;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(59,130,246,0.4)}

/* Ajout manuel client */
.add-client-card{background:white;border-radius:16px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.add-client-title{font-size:14px;font-weight:700;color:#1a1a1a;margin-bottom:12px}
.add-row{display:flex;gap:10px}
.btn-add{padding:14px 18px;border-radius:12px;background:#22c55e;color:white;font-size:14px;font-weight:700;border:none;cursor:pointer;white-space:nowrap}

/* RESULT */
#result-screen{display:none}
.result-card{background:white;border-radius:20px;padding:28px 24px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08);margin-bottom:16px}
.result-check{width:70px;height:70px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;font-size:32px;margin:0 auto 14px;box-shadow:0 4px 16px rgba(34,197,94,0.35)}
.result-check.reward{background:#f59e0b}
.result-name{font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:4px}
.result-sub{font-size:13px;color:#6b7280;margin-bottom:20px}
.points-display{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:16px}
.pts{text-align:center}
.pts-num{font-size:32px;font-weight:900}
.pts-num.before{color:#d1d5db}
.pts-num.after{color:#3b82f6}
.pts-label{font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px}
.arrow{font-size:24px;color:#3b82f6}
.progress-section{background:#f8fafc;border-radius:12px;padding:14px;margin-bottom:16px}
.prog-info{display:flex;justify-content:space-between;font-size:11px;color:#9ca3af;margin-bottom:6px}
.prog-track{background:#e5e7eb;border-radius:6px;height:8px;overflow:hidden}
.prog-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:6px;transition:width 0.5s}
.prog-hint{text-align:center;font-size:12px;color:#6b7280;margin-top:8px;font-weight:600}
.reward-banner{background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:14px;padding:16px;color:white;text-align:center;margin-bottom:16px}
.reward-banner-title{font-size:18px;font-weight:800;margin-bottom:4px}
.reward-banner-sub{font-size:13px;opacity:0.9}
.btn-next{width:100%;padding:16px;border-radius:14px;background:#1a1a1a;color:white;font-size:16px;font-weight:700;border:none;cursor:pointer}
.btn-logout{background:none;border:none;color:#9ca3af;font-size:12px;cursor:pointer;padding:8px;margin-top:8px}
</style>
</head>
<body>

<div class="header" id="main-header" style="display:none">
  <div class="shop-logo" id="header-logo">?</div>
  <div class="shop-info">
    <h2 id="header-name">Boutique</h2>
    <p id="header-status">Connecté · Gérant</p>
  </div>
</div>

<!-- LOGIN -->
<div class="container" id="login-screen">
  <div class="login-logo">🎯</div>
  <div class="login-title">FidélyPass</div>
  <div class="login-sub">Connectez-vous pour accéder à votre espace gérant</div>
  <input class="input" type="text" id="login-slug" placeholder="Identifiant boutique">
  <input class="input" type="password" id="login-password" placeholder="Mot de passe">
  <div class="login-error" id="login-error">❌ Identifiants incorrects</div>
  <button class="btn-login" onclick="login()">Se connecter</button>
</div>

<!-- SCAN -->
<div class="container" id="scan-screen">
  <div class="stats-mini">
    <div class="stat-mini"><div class="stat-mini-val" id="stat-scans">0</div><div class="stat-mini-label">Scans aujourd'hui</div></div>
    <div class="stat-mini"><div class="stat-mini-val" id="stat-customers">0</div><div class="stat-mini-label">Clients actifs</div></div>
  </div>
  <div class="scan-card">
    <div class="scan-icon">📷</div>
    <div class="scan-title">Scanner une carte</div>
    <div class="scan-sub">Demandez au client d'ouvrir sa carte dans son Wallet et entrez son numéro client</div>
    <button class="btn-scan" onclick="showScanInput()">📷 Scanner maintenant</button>
  </div>
  <div class="add-client-card">
    <div class="add-client-title">➕ Nouveau client</div>
    <div class="add-row">
      <input class="input" type="text" id="new-customer-name" placeholder="Prénom du client">
      <button class="btn-add" onclick="addCustomer()">Ajouter</button>
    </div>
  </div>
</div>

<!-- SCAN INPUT -->
<div class="container" id="scan-input-screen" style="display:none">
  <div class="scan-card">
    <div class="scan-icon">🔢</div>
    <div class="scan-title">ID Client</div>
    <div class="scan-sub">Entrez le numéro client (affiché sur sa carte)</div>
    <input class="input" type="number" id="customer-id-input" placeholder="Ex: 1" style="margin-bottom:16px;text-align:center;font-size:24px;font-weight:800">
    <button class="btn-scan" onclick="doScan()">Valider le scan</button>
    <br><button class="btn-logout" onclick="showScreen('scan')">← Retour</button>
  </div>
</div>

<!-- RESULT -->
<div class="container" id="result-screen">
  <div class="result-card">
    <div class="result-check" id="result-icon">✓</div>
    <div class="result-name" id="result-name">Client</div>
    <div class="result-sub" id="result-sub">Points mis à jour</div>
    <div class="points-display">
      <div class="pts"><div class="pts-num before" id="pts-before">0</div><div class="pts-label">Avant</div></div>
      <div class="arrow">→</div>
      <div class="pts"><div class="pts-num after" id="pts-after">0</div><div class="pts-label">Après</div></div>
    </div>
    <div class="progress-section" id="progress-section">
      <div class="prog-info"><span>Progression</span><span id="prog-text">0/100</span></div>
      <div class="prog-track"><div class="prog-fill" id="prog-fill" style="width:0%"></div></div>
      <div class="prog-hint" id="prog-hint"></div>
    </div>
    <div class="reward-banner" id="reward-banner" style="display:none">
      <div class="reward-banner-title">🎉 Récompense débloquée !</div>
      <div class="reward-banner-sub" id="reward-text-display"></div>
    </div>
  </div>
  <button class="btn-next" onclick="showScreen('scan')">Scanner le prochain client</button>
  <br><button class="btn-logout" onclick="logout()">Se déconnecter</button>
</div>

<script>
let currentShop = null;

function showScreen(id) {
  ['login-screen','scan-screen','scan-input-screen','result-screen'].forEach(s => {
    document.getElementById(s).style.display = s===id+'-screen'||s===id ? 'block' : 'none';
  });
  if(id==='scan') loadStats();
}

async function login() {
  const slug = document.getElementById('login-slug').value;
  const password = document.getElementById('login-password').value;
  const res = await fetch('/api/shops/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug,password})});
  const data = await res.json();
  if(data.success) {
    currentShop = data.shop;
    document.getElementById('header-logo').textContent = currentShop.name.slice(0,2).toUpperCase();
    document.getElementById('header-logo').style.background = currentShop.color;
    document.getElementById('header-name').textContent = currentShop.name;
    document.getElementById('main-header').style.display = 'flex';
    showScreen('scan');
  } else {
    document.getElementById('login-error').style.display = 'block';
  }
}

async function loadStats() {
  if(!currentShop) return;
  const res = await fetch('/api/shops/'+currentShop.id+'/stats');
  const data = await res.json();
  document.getElementById('stat-customers').textContent = data.total_customers;
  document.getElementById('stat-scans').textContent = data.total_scans;
}

function showScanInput() { showScreen('scan-input'); }

async function doScan() {
  const customerId = document.getElementById('customer-id-input').value;
  if(!customerId) return;
  const res = await fetch('/api/scan', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customer_id:parseInt(customerId),shop_id:currentShop.id})});
  const data = await res.json();
  if(data.success) {
    document.getElementById('result-name').textContent = data.customer_name;
    document.getElementById('pts-before').textContent = data.points_before;
    document.getElementById('pts-after').textContent = data.points_after;
    const pct = Math.min(100, Math.round((data.points_after/data.points_goal)*100));
    document.getElementById('prog-fill').style.width = pct+'%';
    document.getElementById('prog-text').textContent = data.points_after+'/'+data.points_goal;
    if(data.reward_unlocked) {
      document.getElementById('result-icon').textContent = '🎉';
      document.getElementById('result-icon').classList.add('reward');
      document.getElementById('result-sub').textContent = 'Récompense débloquée !';
      document.getElementById('reward-banner').style.display = 'block';
      document.getElementById('reward-text-display').textContent = data.reward_text;
      document.getElementById('prog-hint').textContent = 'Points remis à zéro';
      document.getElementById('progress-section').style.display = 'none';
    } else {
      document.getElementById('result-icon').textContent = '✓';
      document.getElementById('result-icon').classList.remove('reward');
      document.getElementById('result-sub').textContent = '+'+data.points_added+' points gagnés !';
      document.getElementById('reward-banner').style.display = 'none';
      document.getElementById('progress-section').style.display = 'block';
      const remaining = data.points_goal - data.points_after;
      document.getElementById('prog-hint').textContent = 'Encore '+remaining+' pts pour : '+data.reward_text+' 🎁';
    }
    document.getElementById('customer-id-input').value = '';
    showScreen('result');
  } else {
    alert('❌ '+data.error);
  }
}

async function addCustomer() {
  const name = document.getElementById('new-customer-name').value;
  if(!name||!currentShop) return;
  const res = await fetch('/api/customers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shop_id:currentShop.id,name})});
  const data = await res.json();
  if(data.success) {
    alert('✅ Client ajouté ! Son numéro client est : #'+data.id);
    document.getElementById('new-customer-name').value='';
    loadStats();
  }
}

function logout() {
  currentShop = null;
  document.getElementById('main-header').style.display = 'none';
  showScreen('login');
}

// Auto-login si slug dans URL
const urlParams = new URLSearchParams(window.location.search);
const shopSlug = urlParams.get('shop');
if(shopSlug) document.getElementById('login-slug').value = shopSlug;
</script>
</body>
</html>
EOF

echo ""
echo "✅ FidélyPass est prêt ! Lance le serveur avec : node index.js"
echo "   Puis ouvre : http://localhost:3000"
