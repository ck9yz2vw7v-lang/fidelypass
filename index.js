const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe
let stripeClient = null;
function getStripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY non definie');
    stripeClient = require('stripe')(key);
  }
  return stripeClient;
}
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Web Push (VAPID)
const webpush = require('web-push');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:contact@fidelypass.fr', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Sessions
const sessions = {};

// Recharge les sessions existantes depuis la DB au démarrage (survit aux redéploiements)
try {
  const rows = db.prepare('SELECT token, shop_id FROM sessions_store').all();
  rows.forEach(r => { sessions[r.token] = r.shop_id; });
  console.log('Sessions rechargées:', rows.length);
} catch (e) {
  console.log('Aucune session à recharger:', e.message);
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function saveSession(token, shopId) {
  sessions[token] = shopId;
  try { db.prepare('INSERT OR REPLACE INTO sessions_store (token, shop_id) VALUES (?, ?)').run(token, shopId); } catch(e) {}
}

function deleteSession(token) {
  delete sessions[token];
  try { db.prepare('DELETE FROM sessions_store WHERE token = ?').run(token); } catch(e) {}
}

function requireShopAuth(req, res, next) {
  const token = req.headers['x-shop-token'];
  const shopId = req.params.id || req.params.shop_id || req.body.shop_id;
  if (!token || !sessions[token] || String(sessions[token]) !== String(shopId)) {
    return res.status(403).json({ success: false, error: 'Non autorisé' });
  }
  next();
}

// Webhook Stripe doit recevoir le body brut
app.use('/webhook', express.raw({ type: 'application/json' }));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter sur le login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 tentatives
  message: { success: false, error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Migration DB : ajouter colonnes Stripe si elles n'existent pas
try {
  db.prepare("ALTER TABLE shops ADD COLUMN stripe_customer_id TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN stripe_subscription_id TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN active INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN email TEXT").run();
} catch(e) {}

// ─────────────────────────────────────────────
// ROUTES EXISTANTES
// ─────────────────────────────────────────────

app.get('/api/test', (req, res) => res.json({ message: 'FidélyPass fonctionne !' }));

app.post('/api/shops', async (req, res) => {
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const stmt = db.prepare(`INSERT INTO shops (name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const result = stmt.run(name, slug, hashedPassword, reward_text, points_per_euro || 1, points_goal, color, google_review_url || null, email || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/shops', (req, res) => res.json(db.prepare('SELECT * FROM shops').all()));

app.post('/api/shops/login', loginLimiter, async (req, res) => {
  const { slug, password } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
  if (!shop) return res.status(401).json({ success: false, error: 'Identifiants incorrects' });

  // Support anciens mots de passe en clair (migration progressive)
  let valid = false;
  if (shop.password.startsWith('$2')) {
    valid = await bcrypt.compare(password, shop.password);
  } else {
    // Mot de passe en clair — on vérifie puis on migre
    valid = (password === shop.password);
    if (valid) {
      const hashed = await bcrypt.hash(password, 10);
      db.prepare('UPDATE shops SET password = ? WHERE id = ?').run(hashed, shop.id);
    }
  }

  if (!valid) return res.status(401).json({ success: false, error: 'Identifiants incorrects' });
  if (shop.active === 0) return res.status(403).json({ success: false, error: 'Boutique suspendue — paiement en attente' });

  const token = generateToken();
  saveSession(token, shop.id);
  res.json({ success: true, shop, token });
});

app.get('/api/shops/:id/stats', requireShopAuth, (req, res) => {
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

app.put('/api/customers/:id/points', requireShopAuth, (req, res) => {
  const { points, shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  db.prepare('UPDATE customers SET points = ? WHERE id = ?').run(points, req.params.id);
  res.json({ success: true });
});

app.post('/api/scan', requireShopAuth, (req, res) => {
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
  res.json({ success: true, customer_name: customer.name, points_before: customer.points, points_after: newPoints, points_added: pointsEarned, amount_paid: amount, reward_unlocked: rewardUnlocked, reward_text: shop.reward_text, points_goal: shop.points_goal, google_review_url: shop.google_review_url || null });
});

app.post('/api/reward/:customer_id', requireShopAuth, (req, res) => {
  const { shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.customer_id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  db.prepare('UPDATE customers SET points = 0 WHERE id = ?').run(req.params.customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(req.params.customer_id, shop_id, 0);
  res.json({ success: true, google_review_url: shop.google_review_url || null });
});

app.get('/api/shops/:shop_id/customers', requireShopAuth, (req, res) => {
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

// ─────────────────────────────────────────────
// WEB PUSH
// ─────────────────────────────────────────────

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/customers/:id/subscribe', (req, res) => {
  const { subscription } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ success: false, error: 'Abonnement invalide' });
  }
  try {
    // Évite les doublons pour le même endpoint
    db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ? AND endpoint = ?')
      .run(req.params.id, subscription.endpoint);
    db.prepare('INSERT INTO push_subscriptions (customer_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
      .run(req.params.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/customers/:id/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  try {
    if (endpoint) {
      db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ? AND endpoint = ?').run(req.params.id, endpoint);
    } else {
      db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ?').run(req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/shops/:id/notify', requireShopAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message vide' });
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ success: false, error: 'Clés VAPID non configurées côté serveur' });
  }
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });

  const subs = db.prepare(`
    SELECT ps.* FROM push_subscriptions ps
    JOIN customers c ON c.id = ps.customer_id
    WHERE c.shop_id = ?
  `).all(req.params.id);

  const payload = JSON.stringify({ title: shop.name, body: message.trim() });
  let sent = 0, failed = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      failed++;
      // Abonnement expiré ou invalide → on le supprime
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }

  res.json({ success: true, sent, failed, total: subs.length });
});

app.get('/card/:id', (req, res) => {
  const id = req.params.id;
  const ua = req.headers['user-agent'] || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  let walletHtml = '';
  if (!isAndroid) {
    walletHtml = '<p style="margin-top:16px;font-size:13px;color:#9ca3af">🍎 Apple Wallet bientôt disponible</p>';
  } else {
    walletHtml = '<div id="wallet-btn"><script>fetch("/api/customers/' + id + '/wallet").then(r=>r.json()).then(d=>{if(d.url){document.getElementById("wallet-btn").innerHTML=\'<a href="\'+d.url+\'" target="_blank"><img src="https://pay.google.com/about/static/sample-assets/pay-with-google/add-to-wallet-button.svg" style="width:200px;margin-top:8px" alt="Ajouter à Google Wallet"><\\/a>\';}});<\\/script></div>';
  }

  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ma carte FidélyPass</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:340px}h1{font-size:22px;font-weight:800;margin-bottom:4px}p{color:#6b7280;font-size:13px;margin-bottom:24px}#qr{width:200px;height:200px;border-radius:12px}.id{margin-top:16px;font-size:13px;color:#9ca3af}.review-banner{margin-top:20px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px;padding:16px;color:white;text-align:center;display:none}.review-banner h3{font-size:16px;font-weight:800;margin-bottom:6px}.review-banner p{color:rgba(255,255,255,0.9);font-size:13px;margin-bottom:12px}.review-btn{display:inline-block;background:white;color:#d97706;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none}.notif-btn{margin-top:16px;background:#f3f4f6;color:#374151;border:none;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer}.notif-btn.on{background:#dcfce7;color:#16a34a}.unsub-link{display:block;margin-top:8px;font-size:11px;color:#9ca3af;text-decoration:underline;cursor:pointer;background:none;border:none}.ios-hint{margin-top:12px;background:#fef3c7;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400e;text-align:left;line-height:1.5;display:none}</style></head><body><div class="card"><h1>🎯 FidélyPass</h1><p>Présentez ce QR code au gérant</p><img id="qr" src="" alt="QR Code"><div class="id">Carte n°${id}</div>${walletHtml}<button class="notif-btn" id="notif-btn" onclick="enableNotifs()">🔔 Activer les notifications</button><button class="unsub-link" id="unsub-link" onclick="disableNotifs()" style="display:none">Se désabonner des notifications</button><div class="ios-hint" id="ios-hint">📲 Sur iPhone : pour recevoir les notifications, ajoutez d'abord cette page à votre écran d'accueil (bouton partager <strong>⬆️</strong> puis "Sur l'écran d'accueil"), ouvrez l'app depuis l'icône, puis réessayez.</div><div class="review-banner" id="review-banner"><h3>🎉 Merci pour votre fidélité !</h3><p>Votre avis compte beaucoup pour nous</p><a id="review-link" class="review-btn" href="#" target="_blank">⭐ Laisser un avis Google</a></div></div><script>
const IS_IOS = ${isIOS};
const IS_STANDALONE = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

fetch("/api/customers/${id}/qr").then(r=>r.json()).then(d=>document.getElementById("qr").src=d.qr);
const urlParams=new URLSearchParams(window.location.search);
if(urlParams.get("reward")==="1"&&urlParams.get("review")){const b=document.getElementById("review-banner");const l=document.getElementById("review-link");l.href=decodeURIComponent(urlParams.get("review"));b.style.display="block";}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function enableNotifs() {
  const btn = document.getElementById('notif-btn');
  if (IS_IOS && !IS_STANDALONE) {
    document.getElementById('ios-hint').style.display = 'block';
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Notifications non supportées sur ce navigateur.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notifications refusées.'); return; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await fetch('/api/vapid-public-key').then(r => r.json());
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
    await fetch('/api/customers/${id}/subscribe', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ subscription: sub })
    });
    btn.textContent = '🔔 Notifications activées';
    btn.classList.add('on');
    document.getElementById('unsub-link').style.display = 'block';
    document.getElementById('ios-hint').style.display = 'none';
  } catch (err) {
    console.error(err);
    alert('Impossible d\\'activer les notifications.');
  }
}

async function disableNotifs() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/customers/${id}/unsubscribe', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
        await sub.unsubscribe();
      }
    }
    const btn = document.getElementById('notif-btn');
    btn.textContent = '🔔 Activer les notifications';
    btn.classList.remove('on');
    document.getElementById('unsub-link').style.display = 'none';
  } catch (err) {
    console.error(err);
  }
}

if ('serviceWorker' in navigator && Notification.permission === 'granted') {
  navigator.serviceWorker.getRegistration('/sw.js').then(reg => {
    if (reg) {
      reg.pushManager.getSubscription().then(sub => {
        if (sub) {
          document.getElementById('notif-btn').textContent = '🔔 Notifications activées';
          document.getElementById('notif-btn').classList.add('on');
          document.getElementById('unsub-link').style.display = 'block';
        }
      });
    }
  });
}
<\/script></body></html>`);
});

app.put('/api/shops/:id', async (req, res) => {
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email } = req.body;
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    let newPassword = shop.password;
    if (password && password.trim() !== '') {
      newPassword = await bcrypt.hash(password, 10);
    }
    db.prepare(`UPDATE shops SET name=?, slug=?, password=?, reward_text=?, points_per_euro=?, points_goal=?, color=?, google_review_url=?, email=? WHERE id=?`)
      .run(name, slug, newPassword, reward_text, points_per_euro || 1, points_goal, color, google_review_url || null, email || shop.email || null, req.params.id);
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

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || auth !== 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64')) {
    res.set('WWW-Authenticate', 'Basic realm="FidelyPass Admin"');
    return res.status(401).send('Acces refuse');
  }
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────────────────────────────
// LEADS (formulaire de contact landing page)
// ─────────────────────────────────────────────

app.post('/api/leads', async (req, res) => {
  const { business_name, phone } = req.body;
  if (!business_name || !business_name.trim() || !phone || !phone.trim()) {
    return res.status(400).json({ success: false, error: 'Nom et téléphone requis' });
  }
  try {
    db.prepare('INSERT INTO leads (business_name, phone) VALUES (?, ?)')
      .run(business_name.trim(), phone.trim());
    res.json({ success: true });

    // Notifie l'admin par push (ne bloque pas la réponse au client)
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const admins = db.prepare('SELECT * FROM admin_subscriptions').all();
      const payload = JSON.stringify({
        title: '📩 Nouvelle demande FidélyPass',
        body: business_name.trim() + ' souhaite être contacté'
      });
      for (const sub of admins) {
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        ).catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            db.prepare('DELETE FROM admin_subscriptions WHERE id = ?').run(sub.id);
          }
        });
      }
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/leads', requireAdmin, (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(leads);
});

app.put('/api/admin/leads/:id/seen', requireAdmin, (req, res) => {
  db.prepare('UPDATE leads SET seen = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/leads/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// NOTIFICATIONS PUSH POUR L'ADMIN
// ─────────────────────────────────────────────

app.post('/api/admin/subscribe', requireAdmin, (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ success: false, error: 'Abonnement invalide' });
  }
  try {
    db.prepare('DELETE FROM admin_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
    db.prepare('INSERT INTO admin_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)')
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/unsubscribe', requireAdmin, (req, res) => {
  const { endpoint } = req.body;
  try {
    if (endpoint) db.prepare('DELETE FROM admin_subscriptions WHERE endpoint = ?').run(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/shops/:id/stats', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  const customers = db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ?').get(req.params.id);
  const scans = db.prepare('SELECT COUNT(*) as count FROM scans WHERE shop_id = ?').get(req.params.id);
  const rewards = db.prepare("SELECT COUNT(*) as count FROM scans WHERE shop_id = ? AND points_added = 0").get(req.params.id);
  res.json({ shop, total_customers: customers.count, total_scans: scans.count, total_rewards: rewards.count });
});

// ─────────────────────────────────────────────
// STRIPE — Créer lien de paiement pour une boutique
// ─────────────────────────────────────────────

app.post('/api/shops/:id/create-payment', requireAdmin, async (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });

    const email = shop.email || req.body.email;
    if (!email) return res.status(400).json({ success: false, error: 'Email gérant requis' });

    // Compter les boutiques actives de ce gérant (même email) pour remise multi-boutiques
    const shopCount = db.prepare("SELECT COUNT(*) as count FROM shops WHERE email = ? AND active = 1 AND id != ?").get(email, shop.id);
    const isMulti = shopCount.count >= 1;
    const monthlyPrice = isMulti ? 2400 : 2900; // centimes : 24€ ou 29€

    // Créer ou récupérer le client Stripe
    let stripeCustomerId = shop.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({ email, name: shop.name, metadata: { shop_id: String(shop.id) } });
      stripeCustomerId = customer.id;
      db.prepare('UPDATE shops SET stripe_customer_id = ?, email = ? WHERE id = ?').run(stripeCustomerId, email, shop.id);
    }

    // Créer session Stripe Checkout : 80€ installation + 29€/mois abonnement
    const session = await getStripe().checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: 'Installation FidélyPass — ' + shop.name },
            unit_amount: 8000, // 80€
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'eur',
            product_data: { name: 'Abonnement FidélyPass mensuel' + (isMulti ? ' (tarif multi-boutiques)' : '') },
            unit_amount: monthlyPrice,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: 'https://fidelypass-production.up.railway.app/admin?payment=success',
      cancel_url: 'https://fidelypass-production.up.railway.app/admin?payment=cancel',
      metadata: { shop_id: String(shop.id) },
    });

    res.json({ success: true, payment_url: session.url, is_multi: isMulti, monthly_price: monthlyPrice / 100 });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// STRIPE — Webhook
// ─────────────────────────────────────────────

app.post('/webhook', (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const session = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const shopId = session.metadata && session.metadata.shop_id;
    if (shopId) {
      const subId = session.subscription;
      db.prepare('UPDATE shops SET active = 1, stripe_subscription_id = ? WHERE id = ?').run(subId || null, shopId);
      console.log('Boutique activée:', shopId);
    }
  }

  if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
    const subId = session.id || (session.subscription);
    if (subId) {
      db.prepare('UPDATE shops SET active = 0 WHERE stripe_subscription_id = ?').run(subId);
      console.log('Boutique suspendue pour subscription:', subId);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => console.log('FidelyPass tourne sur http://localhost:' + PORT));