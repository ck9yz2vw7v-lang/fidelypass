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
  const sessionShopId = token ? sessions[token] : undefined;
  const candidates = [req.params.shop_id, req.body && req.body.shop_id, req.params.id]
    .filter(v => v !== undefined && v !== null);
  const authorized = sessionShopId !== undefined && candidates.some(c => String(sessionShopId) === String(c));
  if (!token || !authorized) {
    return res.status(403).json({ success: false, error: 'Non autorisé' });
  }
  next();
}

// Webhook Stripe doit recevoir le body brut
app.use('/webhook', express.raw({ type: 'application/json' }));

app.use(cors());
app.use(express.json({ limit: '5mb' }));
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
  db.prepare("ALTER TABLE shops ADD COLUMN google_review_url TEXT").run();
} catch(e) {}
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
try {
  db.prepare("ALTER TABLE shops ADD COLUMN payment_exempt INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN waive_setup_fee INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN currency TEXT DEFAULT 'EUR'").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN menu_url TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN menu_file_base64 TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN menu_file_type TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN latitude REAL").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN longitude REAL").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN logo_base64 TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN phone TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE shops ADD COLUMN opening_hours TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE customers ADD COLUMN pass_auth_token TEXT").run();
} catch(e) {}
try {
  db.prepare("ALTER TABLE customers ADD COLUMN pass_updated_at TEXT").run();
} catch(e) {}
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS apple_pass_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_library_id TEXT NOT NULL,
      pass_type_id TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      push_token TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(device_library_id, serial_number)
    )
  `).run();
} catch(e) {}

// Génère (si besoin) le jeton d'authentification utilisé par le service web Apple Wallet pour ce client
// Extrait le type MIME et les données d'un fichier envoyé en data URL (ex: "data:application/pdf;base64,...")
function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
  if (!allowed.includes(match[1])) return null;
  return { mime: match[1], base64: match[2] };
}

// URL publique du logo d'une boutique, à utiliser comme icône de notification (undefined si pas de logo -> l'icône FidélyPass par défaut du service worker sera utilisée)
function shopIconUrl(logoBase64, shopId) {
  return logoBase64 ? 'https://fidelypass-production.up.railway.app/shops/' + shopId + '/logo-file' : undefined;
}

function ensurePassAuthToken(customerId) {
  const customer = db.prepare('SELECT pass_auth_token FROM customers WHERE id = ?').get(customerId);
  if (customer && customer.pass_auth_token) return customer.pass_auth_token;
  const token = crypto.randomBytes(20).toString('hex');
  db.prepare('UPDATE customers SET pass_auth_token = ? WHERE id = ?').run(token, customerId);
  return token;
}

// Marque la carte d'un client comme mise à jour, et pousse une notification Apple Wallet aux appareils enregistrés
async function touchPassAndPush(customerId) {
  try {
    db.prepare('UPDATE customers SET pass_updated_at = ? WHERE id = ?').run(new Date().toISOString(), customerId);
    const serialNumber = 'fidelypass-' + customerId;
    const regs = db.prepare('SELECT push_token FROM apple_pass_registrations WHERE serial_number = ?').all(serialNumber);
    if (!regs.length) return;
    const { sendApplePushNotification } = require('./wallet');
    for (const reg of regs) {
      sendApplePushNotification(reg.push_token).catch(() => {});
    }
  } catch (e) {
    console.error('Push Apple Wallet erreur:', e.message);
  }
}

// ─────────────────────────────────────────────
// ROUTES EXISTANTES
// ─────────────────────────────────────────────

app.get('/api/test', (req, res) => res.json({ message: 'FidélyPass fonctionne !' }));

app.post('/api/shops', async (req, res) => {
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, phone, opening_hours } = req.body;
  try {
    const menuFile = parseDataUrl(menu_file_base64);
    const hashedPassword = await bcrypt.hash(password, 10);
    const stmt = db.prepare(`INSERT INTO shops (name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, menu_file_type, phone, opening_hours, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const result = stmt.run(name, slug, hashedPassword, reward_text, points_per_euro || 1, points_goal, color, google_review_url || null, email || null, referral_bonus_points != null ? referral_bonus_points : 10, currency || 'EUR', menu_url || null, latitude != null && latitude !== '' ? parseFloat(latitude) : null, longitude != null && longitude !== '' ? parseFloat(longitude) : null, logo_base64 || null, menuFile ? menuFile.base64 : null, menuFile ? menuFile.mime : null, phone || null, opening_hours || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/shops', (req, res) => {
  const shops = db.prepare('SELECT * FROM shops').all();
  // On n'envoie pas les logos/fichiers menu en entier dans la liste (potentiellement plusieurs Mo
  // par boutique) — juste un indicateur de présence. Le détail complet est chargé à la demande
  // via /api/admin/shops/:id/full au moment d'ouvrir la modale de modification.
  const light = shops.map(s => {
    const { logo_base64, menu_file_base64, ...rest } = s;
    return { ...rest, has_logo: !!logo_base64, has_menu_file: !!menu_file_base64 };
  });
  res.json(light);
});

app.get('/api/admin/shops/:id/full', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
  res.json(shop);
});

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
  if (shop.active === 0 && shop.payment_exempt !== 1) return res.status(403).json({ success: false, error: 'Boutique suspendue — paiement en attente' });

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

app.post('/api/customers', async (req, res) => {
  const { shop_id, name, ref } = req.body;
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
    if (!shop) return res.status(400).json({ success: false, error: 'Boutique introuvable' });

    // Vérifie que le parrain est un client valide de la même boutique
    let referrer = null;
    if (ref) {
      referrer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(ref, shop_id);
    }
    const bonus = shop.referral_bonus_points || 0;
    const startingPoints = referrer ? bonus : 0;

    const stmt = db.prepare('INSERT INTO customers (shop_id, name, points, referred_by) VALUES (?, ?, ?, ?)');
    const result = stmt.run(shop_id, name, startingPoints, referrer ? referrer.id : null);
    res.json({ success: true, id: result.lastInsertRowid, bonus_received: startingPoints });

    // Récompense le parrain + le notifie
    if (referrer && bonus > 0) {
      db.prepare('UPDATE customers SET points = points + ? WHERE id = ?').run(bonus, referrer.id);
      if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
        const subs = db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(referrer.id);
        const payload = JSON.stringify({
          title: `🎉 ${shop.name}`,
          body: `${name} a rejoint grâce à vous ! +${bonus} points offerts 🎁`,
          url: '/card/' + referrer.id,
          icon: shopIconUrl(shop.logo_base64, shop.id)
        });
        for (const sub of subs) {
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          ).catch(err => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            }
          });
        }
      }
    }
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/customers/:id', (req, res) => {
  const customer = db.prepare(`
    SELECT c.*, s.points_goal, s.reward_text, s.google_review_url, s.color, s.slug, s.name as shop_name, s.referral_bonus_points,
           s.menu_url, s.phone, s.opening_hours, (s.menu_file_base64 IS NOT NULL) as has_menu_file
    FROM customers c JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Client introuvable' });
  if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
  res.json(customer);
});

app.get('/api/customers/:id/history', (req, res) => {
  const history = db.prepare(`
    SELECT points_added, scanned_at FROM scans
    WHERE customer_id = ? ORDER BY scanned_at DESC LIMIT 10
  `).all(req.params.id);
  res.json(history);
});

app.put('/api/customers/:id/points', requireShopAuth, (req, res) => {
  const { points, shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  db.prepare('UPDATE customers SET points = ? WHERE id = ?').run(points, req.params.id);
  res.json({ success: true });
});

app.delete('/api/customers/:id', requireShopAuth, (req, res) => {
  const { shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  db.prepare('DELETE FROM scans WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM apple_pass_registrations WHERE serial_number = ?').run('fidelypass-' + req.params.id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/scan', requireShopAuth, async (req, res) => {
  const { customer_id, shop_id, amount } = req.body;
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(customer_id, shop_id);
  if (!shop || !customer) return res.status(404).json({ success: false, error: 'Introuvable' });
  const pointsPerEuro = shop.points_per_euro || 1;
  const pointsEarned = Math.floor((amount || 0) * pointsPerEuro);
  const newPoints = customer.points + pointsEarned;
  const rewardUnlocked = newPoints >= shop.points_goal;
  db.prepare('UPDATE customers SET points = ?, total_visits = total_visits + 1, last_visit = CURRENT_TIMESTAMP WHERE id = ?').run(newPoints, customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(customer_id, shop_id, pointsEarned);
  touchPassAndPush(customer_id);
  res.json({ success: true, customer_name: customer.name, points_before: customer.points, points_after: newPoints, points_added: pointsEarned, amount_paid: amount, reward_unlocked: rewardUnlocked, reward_text: shop.reward_text, points_goal: shop.points_goal, google_review_url: shop.google_review_url || null });

  // Notifie le client par push : récompense débloquée, ou simple progression
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(customer_id);
    let payload;
    if (rewardUnlocked) {
      const body = shop.google_review_url
        ? `Vous avez débloqué : ${shop.reward_text} 🎁 Laissez un avis pour le récupérer !`
        : `Vous avez débloqué : ${shop.reward_text} 🎁 Montrez cet écran au gérant !`;
      payload = JSON.stringify({ title: `🎉 ${shop.name}`, body, url: '/card/' + customer_id, icon: shopIconUrl(shop.logo_base64, shop.id) });
    } else {
      const remaining = shop.points_goal - newPoints;
      payload = JSON.stringify({
        title: `🎯 ${shop.name}`,
        body: `Vous avez ${newPoints} points sur ${shop.points_goal}. Encore ${remaining} pts pour : ${shop.reward_text} 🎁`,
        url: '/card/' + customer_id,
        icon: shopIconUrl(shop.logo_base64, shop.id)
      });
    }
    for (const sub of subs) {
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        }
      });
    }
  }
});

app.post('/api/reward/:customer_id', requireShopAuth, (req, res) => {
  const { shop_id } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.customer_id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  db.prepare('UPDATE customers SET points = 0 WHERE id = ?').run(req.params.customer_id);
  db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(req.params.customer_id, shop_id, 0);
  touchPassAndPush(req.params.customer_id);
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
    const customer = db.prepare(`
      SELECT c.*, s.id as shop_id, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.google_review_url, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Client introuvable' });
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    const { createWalletPass } = require('./wallet');
    const url = await createWalletPass(customer);
    res.json({ url });
  } catch (err) {
    console.error('Wallet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// SERVICE WEB APPLE WALLET (mise à jour automatique des cartes)
// ─────────────────────────────────────────────

const APPLE_PASS_TYPE_ID = 'pass.com.fidelypass.loyalty';

function customerIdFromSerial(serialNumber) {
  const id = String(serialNumber || '').replace('fidelypass-', '');
  return /^\d+$/.test(id) ? Number(id) : null;
}

function checkApplePassAuth(req, customerId) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('ApplePass ') ? header.slice('ApplePass '.length) : null;
  if (!token) return false;
  const customer = db.prepare('SELECT pass_auth_token FROM customers WHERE id = ?').get(customerId);
  return !!customer && customer.pass_auth_token === token;
}

// Enregistrement d'un appareil pour recevoir les mises à jour push d'une carte
app.post('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
  const customerId = customerIdFromSerial(serialNumber);
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
  if (!checkApplePassAuth(req, customerId)) return res.status(401).end();
  const pushToken = req.body && req.body.pushToken;
  if (!pushToken) return res.status(400).end();
  const existing = db.prepare('SELECT id FROM apple_pass_registrations WHERE device_library_id = ? AND serial_number = ?').get(deviceLibraryIdentifier, serialNumber);
  if (existing) {
    db.prepare('UPDATE apple_pass_registrations SET push_token = ? WHERE id = ?').run(pushToken, existing.id);
    return res.status(200).end();
  }
  db.prepare('INSERT INTO apple_pass_registrations (device_library_id, pass_type_id, serial_number, push_token) VALUES (?, ?, ?, ?)')
    .run(deviceLibraryIdentifier, passTypeIdentifier, serialNumber, pushToken);
  res.status(201).end();
});

// Désenregistrement d'un appareil
app.delete('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
  const customerId = customerIdFromSerial(serialNumber);
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
  if (!checkApplePassAuth(req, customerId)) return res.status(401).end();
  db.prepare('DELETE FROM apple_pass_registrations WHERE device_library_id = ? AND serial_number = ?').run(deviceLibraryIdentifier, serialNumber);
  res.status(200).end();
});

// Liste des cartes à mettre à jour pour un appareil donné
app.get('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID) return res.status(404).end();
  const rows = db.prepare('SELECT serial_number FROM apple_pass_registrations WHERE device_library_id = ?').all(deviceLibraryIdentifier);
  if (!rows.length) return res.status(204).end();
  res.json({ lastUpdated: String(Date.now()), serialNumbers: rows.map(r => r.serial_number) });
});

// Renvoie la carte à jour (appelé par l'iPhone quand une notification push est reçue)
app.get('/apple-wallet/v1/passes/:passTypeIdentifier/:serialNumber', async (req, res) => {
  try {
    const { passTypeIdentifier, serialNumber } = req.params;
    const customerId = customerIdFromSerial(serialNumber);
    if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
    if (!checkApplePassAuth(req, customerId)) return res.status(401).end();
    const customer = db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.latitude, s.longitude, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(customerId);
    if (!customer) return res.status(404).end();
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    customer.pass_auth_token = ensurePassAuthToken(customer.id);
    const { createApplePassBuffer } = require('./wallet');
    const buffer = await createApplePassBuffer(customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Last-Modified', new Date().toUTCString());
    res.send(buffer);
  } catch (err) {
    console.error('Apple Wallet update error:', err.message);
    res.status(500).end();
  }
});

// Apple envoie ici des logs de debug — on les affiche simplement dans nos logs serveur
app.post('/apple-wallet/v1/log', (req, res) => {
  console.log('Apple Wallet log:', JSON.stringify(req.body));
  res.status(200).end();
});

app.get('/api/customers/:id/apple-wallet', async (req, res) => {
  try {
    const customer = db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.latitude, s.longitude, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Client introuvable' });
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    customer.pass_auth_token = ensurePassAuthToken(customer.id);
    const { createApplePassBuffer } = require('./wallet');
    const buffer = await createApplePassBuffer(customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', 'attachment; filename=fidelypass.pkpass');
    res.send(buffer);
  } catch (err) {
    console.error('Apple Wallet error:', err.message);
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

  const payload = JSON.stringify({ title: shop.name, body: message.trim(), icon: shopIconUrl(shop.logo_base64, shop.id) });
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
    walletHtml = '<a href="/api/customers/' + id + '/apple-wallet" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;background:#000;color:white;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none">🍎 Ajouter à Apple Wallet</a>';
  } else {
    walletHtml = '<div id="wallet-btn"><script>fetch("/api/customers/' + id + '/wallet").then(r=>r.json()).then(d=>{if(d.url){document.getElementById("wallet-btn").innerHTML=\'<a href="\'+d.url+\'" target="_blank"><img src="https://pay.google.com/about/static/sample-assets/pay-with-google/add-to-wallet-button.svg" style="width:200px;margin-top:8px" alt="Ajouter à Google Wallet"><\\/a>\';}});<\\/script></div>';
  }

  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ma carte FidélyPass</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:340px}h1{font-size:22px;font-weight:800;margin-bottom:4px}p{color:#6b7280;font-size:13px;margin-bottom:24px}#qr{width:200px;height:200px;border-radius:12px}.id{margin-top:16px;font-size:13px;color:#9ca3af}.points-box{margin-top:20px;background:#f8fafc;border-radius:16px;padding:16px}.points-val{font-size:28px;font-weight:900;color:#111827}.points-goal{font-size:13px;color:#6b7280;margin-bottom:10px}.progress-track{background:#e5e7eb;border-radius:99px;height:10px;overflow:hidden}.progress-fill{background:#3b82f6;height:100%;border-radius:99px;transition:width 0.4s ease}.review-banner{margin-top:20px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px;padding:16px;color:white;text-align:center;display:none}.review-banner h3{font-size:16px;font-weight:800;margin-bottom:6px}.review-banner p{color:rgba(255,255,255,0.9);font-size:13px;margin-bottom:12px}.review-btn{display:inline-block;background:white;color:#d97706;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none}.notif-btn{margin-top:16px;background:#f3f4f6;color:#374151;border:none;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer}.notif-btn.on{background:#dcfce7;color:#16a34a}.unsub-link{display:block;margin-top:8px;font-size:11px;color:#9ca3af;text-decoration:underline;cursor:pointer;background:none;border:none}.ios-hint{margin-top:12px;background:#fef3c7;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400e;text-align:left;line-height:1.5;display:none}.section-box{margin-top:20px;background:#f8fafc;border-radius:16px;padding:16px;text-align:left}.section-title{font-size:13px;font-weight:800;color:#374151;margin-bottom:10px;text-align:center}.history-row{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:6px 0;border-bottom:1px solid #e5e7eb}.history-row:last-child{border-bottom:none}.referral-link-box{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:10px;font-size:11px;color:#374151;word-break:break-all;margin-bottom:10px}.referral-copy-btn{width:100%;padding:12px;border-radius:10px;background:#3b82f6;color:white;font-size:13px;font-weight:700;border:none;cursor:pointer}.onboarding-overlay{position:fixed;inset:0;background:linear-gradient(135deg,#0f172a,#1e1b4b 50%,#0f172a);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;padding:32px;text-align:center;overflow:hidden}.onboarding-overlay::before{content:'';position:absolute;inset:-50%;background:radial-gradient(circle at 30% 30%,rgba(59,130,246,0.25),transparent 50%),radial-gradient(circle at 70% 70%,rgba(168,85,247,0.2),transparent 50%);animation:obDrift 8s ease-in-out infinite alternate}@keyframes obDrift{from{transform:translate(0,0) rotate(0deg)}to{transform:translate(3%,3%) rotate(8deg)}}.onboarding-icon{width:88px;height:88px;border-radius:50%;background:rgba(59,130,246,0.15);border:1px solid rgba(96,165,250,0.4);display:flex;align-items:center;justify-content:center;font-size:40px;margin-bottom:24px;animation:obPulse 1.8s ease-in-out infinite;position:relative;z-index:1}@keyframes obPulse{0%,100%{box-shadow:0 0 0 0 rgba(96,165,250,0.35)}50%{box-shadow:0 0 0 16px rgba(96,165,250,0)}}.onboarding-title{color:white;font-size:21px;font-weight:800;margin-bottom:10px;position:relative;z-index:1;animation:obFadeUp 0.5s ease}.onboarding-text{color:#cbd5e1;font-size:14px;line-height:1.6;max-width:280px;position:relative;z-index:1;animation:obFadeUp 0.5s ease 0.1s both}@keyframes obFadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.onboarding-dots{display:flex;gap:8px;margin-top:32px;position:relative;z-index:1}.onboarding-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25);transition:all 0.3s}.onboarding-dot.active{background:#60a5fa;width:22px;border-radius:4px}.onboarding-skip{margin-top:28px;background:none;border:none;color:rgba(255,255,255,0.5);font-size:13px;text-decoration:underline;cursor:pointer;position:relative;z-index:1}.onboarding-cta{margin-top:24px;background:white;color:#1e1b4b;border:none;padding:14px 32px;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;position:relative;z-index:1;display:none}</style></head><body><div class="onboarding-overlay" id="onboarding-overlay"><div class="onboarding-icon" id="ob-icon">📲</div><div class="onboarding-title" id="ob-title">Bienvenue !</div><div class="onboarding-text" id="ob-text">Voici comment profiter de votre carte de fidélité.</div><div class="onboarding-dots" id="ob-dots"></div><button class="onboarding-cta" id="ob-cta" onclick="dismissOnboarding()">C'est parti 🚀</button><button class="onboarding-skip" onclick="dismissOnboarding()">Passer</button></div><div class="card"><h1>🎯 FidélyPass</h1><p>Présentez ce QR code au gérant</p><img id="qr" src="" alt="QR Code"><div class="id">Carte n°${id}</div><div class="points-box" id="points-box" style="display:none"><div class="points-val" id="points-val">0</div><div class="points-goal" id="points-goal-text">sur 0 points</div><div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div></div>${walletHtml}<a id="menu-link" href="#" target="_blank" style="display:none;align-items:center;justify-content:center;gap:8px;margin-top:12px;background:#f3f4f6;color:#374151;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none">📋 Voir le menu</a><a id="phone-link" href="#" style="display:none;align-items:center;justify-content:center;gap:8px;margin-top:12px;background:#f3f4f6;color:#374151;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none">📞 Appeler la boutique</a><div id="hours-text" style="display:none;margin-top:12px;font-size:13px;color:#6b7280;text-align:center">🕒 <span id="hours-value"></span></div><button class="notif-btn" id="notif-btn" onclick="enableNotifs()">🔔 Activer les notifications</button><button class="unsub-link" id="unsub-link" onclick="disableNotifs()" style="display:none">Se désabonner des notifications</button><div class="ios-hint" id="ios-hint">📲 Sur iPhone : pour recevoir les notifications, ajoutez d'abord cette page à votre écran d'accueil (bouton partager <strong>⬆️</strong> puis "Sur l'écran d'accueil"), ouvrez l'app depuis l'icône, puis réessayez.</div><div class="review-banner" id="review-banner"><h3>🎉 Objectif atteint !</h3><p id="review-banner-text">Votre avis compte beaucoup pour nous</p><a id="review-link" class="review-btn" href="#" target="_blank" style="display:none">⭐ Laisser un avis Google</a></div><div class="section-box" id="referral-box" style="display:none"><div class="section-title">🎁 Parrainez un ami</div><p style="font-size:12px;color:#6b7280;margin-bottom:10px;text-align:center">Votre ami reçoit des points, vous aussi !</p><div class="referral-link-box" id="referral-link-text"></div><button class="referral-copy-btn" onclick="copyReferralLink()">📋 Copier mon lien de parrainage</button></div><div class="section-box" id="history-box" style="display:none"><div class="section-title">📋 Historique des visites</div><div id="history-list"></div></div></div><script>
const IS_IOS = ${isIOS};

const OB_STEPS = [
  {icon:'📲', title:'Bienvenue !', text:"On vous montre tout ce qu'il faut faire, une bonne fois pour toutes."},
  {icon:'💳', title:'1. Ajoutez votre carte', text:"Appuyez sur le bouton Wallet ci-dessous pour l'ajouter à Apple Wallet ou Google Wallet."},
  {icon:'🔖', title:'2. Ajoutez cette page à l\\'écran d\\'accueil', text:"Bouton Partager ⬆️ puis \\"Sur l'écran d'accueil\\" — pour la retrouver en un tap, et activer les notifications."},
  {icon:'🔔', title:'3. Activez les notifications', text:"Appuyez sur le bouton 🔔 plus bas pour être prévenu de vos offres et de votre récompense."},
  {icon:'⭐', title:'4. Montrez votre carte à chaque achat', text:"Présentez-la au comptoir à chaque passage pour cumuler des points automatiquement."},
  {icon:'🎁', title:'Vous êtes prêt !', text:"Une fois l'objectif atteint, votre récompense vous attend !"}
];
let obIndex = 0;
let obTimer = null;

function renderOnboardingDots() {
  const dots = document.getElementById('ob-dots');
  if (!dots) return;
  dots.innerHTML = OB_STEPS.map((_, i) => '<div class="onboarding-dot' + (i === obIndex ? ' active' : '') + '"></div>').join('');
}

function showObStep(i) {
  obIndex = i;
  const step = OB_STEPS[i];
  const iconEl = document.getElementById('ob-icon');
  const titleEl = document.getElementById('ob-title');
  const textEl = document.getElementById('ob-text');
  if (!iconEl) return;
  iconEl.textContent = step.icon;
  titleEl.textContent = step.title;
  textEl.textContent = step.text;
  titleEl.style.animation = 'none'; textEl.style.animation = 'none';
  void titleEl.offsetWidth; void textEl.offsetWidth;
  titleEl.style.animation = ''; textEl.style.animation = '';
  renderOnboardingDots();
  document.getElementById('ob-cta').style.display = (i === OB_STEPS.length - 1) ? 'inline-block' : 'none';
}

function dismissOnboarding() {
  clearTimeout(obTimer);
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  overlay.style.transition = 'opacity 0.4s ease';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.remove(); }, 400);
  try { localStorage.setItem('fp_onboarded_${id}', '1'); } catch (e) {}
}

function startOnboarding() {
  let alreadySeen = false;
  try { alreadySeen = localStorage.getItem('fp_onboarded_${id}') === '1'; } catch (e) {}
  if (alreadySeen) {
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) overlay.remove();
    return;
  }
  showObStep(0);
  (function next() {
    if (obIndex < OB_STEPS.length - 1) {
      obTimer = setTimeout(() => { showObStep(obIndex + 1); next(); }, 3400);
    }
  })();
}
startOnboarding();
const IS_STANDALONE = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

fetch("/api/customers/${id}/qr").then(r=>r.json()).then(d=>document.getElementById("qr").src=d.qr);

fetch("/api/customers/${id}").then(r=>r.json()).then(c => {
  if (c.error) return;
  const box = document.getElementById('points-box');
  box.style.display = 'block';
  document.getElementById('points-val').textContent = c.points + ' pts';
  document.getElementById('points-goal-text').textContent = 'sur ' + c.points_goal + ' points';
  const pct = Math.min(100, Math.round((c.points / c.points_goal) * 100));
  document.getElementById('progress-fill').style.width = pct + '%';

  if (c.points >= c.points_goal) {
    const banner = document.getElementById('review-banner');
    const link = document.getElementById('review-link');
    document.getElementById('review-banner-text').textContent = 'Récompense : ' + (c.reward_text || 'à réclamer') + ' — montrez cet écran au gérant !';
    if (c.google_review_url) {
      link.href = c.google_review_url;
      link.style.display = 'inline-block';
    }
    banner.style.display = 'block';
  }

  if (c.menu_url) {
    const menuLink = document.getElementById('menu-link');
    menuLink.href = c.menu_url;
    menuLink.style.display = 'flex';
  }

  if (c.phone) {
    const phoneLink = document.getElementById('phone-link');
    phoneLink.href = 'tel:' + c.phone.replace(/\\s/g, '');
    phoneLink.style.display = 'flex';
  }

  if (c.opening_hours) {
    document.getElementById('hours-value').textContent = c.opening_hours;
    document.getElementById('hours-text').style.display = 'block';
  }

  if (c.slug) {
    window.__referralLink = window.location.origin + '/join/' + c.slug + '?ref=' + c.id;
    document.getElementById('referral-link-text').textContent = window.__referralLink;
    document.getElementById('referral-box').style.display = 'block';
  }
});

fetch("/api/customers/${id}/history").then(r=>r.json()).then(rows => {
  if (!rows || !rows.length) return;
  document.getElementById('history-box').style.display = 'block';
  document.getElementById('history-list').innerHTML = rows.map(r => {
    const d = new Date(r.scanned_at);
    const dateStr = d.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'});
    return '<div class="history-row"><span>' + dateStr + '</span><span>+' + r.points_added + ' pts</span></div>';
  }).join('');
});

async function copyReferralLink() {
  try {
    await navigator.clipboard.writeText(window.__referralLink);
    const btn = document.querySelector('.referral-copy-btn');
    btn.textContent = '✓ Copié !';
    setTimeout(() => { btn.textContent = '📋 Copier mon lien de parrainage'; }, 1500);
  } catch (e) {
    alert('Lien : ' + window.__referralLink);
  }
}

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
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, phone, opening_hours } = req.body;
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    let newPassword = shop.password;
    if (password && password.trim() !== '') {
      newPassword = await bcrypt.hash(password, 10);
    }
    let newMenuFileBase64 = shop.menu_file_base64;
    let newMenuFileType = shop.menu_file_type;
    if (menu_file_base64 !== undefined) {
      if (!menu_file_base64) {
        newMenuFileBase64 = null;
        newMenuFileType = null;
      } else {
        const menuFile = parseDataUrl(menu_file_base64);
        newMenuFileBase64 = menuFile ? menuFile.base64 : null;
        newMenuFileType = menuFile ? menuFile.mime : null;
      }
    }
    db.prepare(`UPDATE shops SET name=?, slug=?, password=?, reward_text=?, points_per_euro=?, points_goal=?, color=?, google_review_url=?, email=?, referral_bonus_points=?, currency=?, menu_url=?, latitude=?, longitude=?, logo_base64=?, menu_file_base64=?, menu_file_type=?, phone=?, opening_hours=? WHERE id=?`)
      .run(
        name, slug, newPassword, reward_text, points_per_euro || 1, points_goal, color, google_review_url || null,
        email || shop.email || null, referral_bonus_points != null ? referral_bonus_points : (shop.referral_bonus_points || 10),
        currency || shop.currency || 'EUR',
        menu_url !== undefined ? (menu_url || null) : shop.menu_url,
        latitude !== undefined && latitude !== '' ? (latitude != null ? parseFloat(latitude) : null) : shop.latitude,
        longitude !== undefined && longitude !== '' ? (longitude != null ? parseFloat(longitude) : null) : shop.longitude,
        logo_base64 !== undefined ? (logo_base64 || null) : shop.logo_base64,
        newMenuFileBase64,
        newMenuFileType,
        phone !== undefined ? (phone || null) : shop.phone,
        opening_hours !== undefined ? (opening_hours || null) : shop.opening_hours,
        req.params.id
      );
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/api/shops/:id', (req, res) => {
  try {
    const customerIds = db.prepare('SELECT id FROM customers WHERE shop_id = ?').all(req.params.id).map(c => c.id);
    if (customerIds.length) {
      const placeholders = customerIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM push_subscriptions WHERE customer_id IN (${placeholders})`).run(...customerIds);
      const serials = customerIds.map(id => 'fidelypass-' + id);
      const serialPlaceholders = serials.map(() => '?').join(',');
      db.prepare(`DELETE FROM apple_pass_registrations WHERE serial_number IN (${serialPlaceholders})`).run(...serials);
    }
    db.prepare('DELETE FROM sessions_store WHERE shop_id = ?').run(req.params.id);
    db.prepare('DELETE FROM scans WHERE shop_id = ?').run(req.params.id);
    db.prepare('DELETE FROM customers WHERE shop_id = ?').run(req.params.id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Sert le logo de la boutique en tant que vraie image accessible publiquement (nécessaire pour
// Google Wallet, qui exige une URL et n'accepte pas une image encodée en base64 directement)
app.get('/shops/:id/logo-file', (req, res) => {
  const shop = db.prepare('SELECT logo_base64 FROM shops WHERE id = ?').get(req.params.id);
  if (!shop || !shop.logo_base64) return res.status(404).send('Aucun logo disponible');
  const match = String(shop.logo_base64).match(/^data:([^;]+);base64,(.+)$/);
  const mime = match ? match[1] : 'image/png';
  const raw = match ? match[2] : shop.logo_base64;
  res.set('Content-Type', mime);
  res.send(Buffer.from(raw, 'base64'));
});

// Sert le fichier menu (image ou PDF) uploadé par la boutique, affiché inline dans le navigateur
app.get('/shops/:id/menu-file', (req, res) => {
  const shop = db.prepare('SELECT menu_file_base64, menu_file_type FROM shops WHERE id = ?').get(req.params.id);
  if (!shop || !shop.menu_file_base64) return res.status(404).send('Aucun menu disponible');
  const buffer = Buffer.from(shop.menu_file_base64, 'base64');
  res.set('Content-Type', shop.menu_file_type || 'application/octet-stream');
  res.set('Content-Disposition', 'inline; filename="menu"');
  res.send(buffer);
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
  res.send('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Rejoindre ' + name + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:380px}.logo{width:64px;height:64px;border-radius:16px;background:' + color + ';display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:white;margin:0 auto 16px}h1{font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:4px}p{color:#6b7280;font-size:14px;margin-bottom:24px}.info{background:#f8fafc;border-radius:12px;padding:14px;margin-bottom:24px;font-size:13px;color:#374151}.ref-info{background:#dcfce7;border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px;color:#16a34a;font-weight:600;display:none}input{width:100%;padding:16px;border:2px solid #e5e7eb;border-radius:14px;font-size:18px;text-align:center;font-weight:700;color:#1a1a1a;outline:none;margin-bottom:12px}input:focus{border-color:#3b82f6}button{width:100%;padding:16px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;font-size:17px;font-weight:700;border:none;cursor:pointer}.error{color:#ef4444;font-size:13px;margin-bottom:12px;display:none}</style></head><body><div class="card"><div class="logo">' + initials + '</div><h1>' + name + '</h1><p>Créez votre carte de fidélité gratuite</p><div class="ref-info" id="ref-info">🎁 Vous avez été invité(e) — points bonus à l\'inscription !</div><div class="info">🎁 Objectif : <strong>' + goal + ' points</strong><br>Récompense : <strong>' + reward + '</strong></div><div class="error" id="e">Veuillez entrer votre prénom</div><input type="text" id="n" placeholder="Votre prénom"><button onclick="j()">Obtenir ma carte 🎯</button></div><script>const ref=new URLSearchParams(window.location.search).get("ref");if(ref)document.getElementById("ref-info").style.display="block";async function j(){const n=document.getElementById("n").value.trim();if(!n){document.getElementById("e").style.display="block";return;}const r=await fetch("/api/customers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shop_id:' + id + ',name:n,ref:ref})});const d=await r.json();if(d.success)window.location.href="/card/"+d.id;}document.getElementById("n").addEventListener("keypress",e=>{if(e.key==="Enter")j();});<\/script></body></html>');
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

app.post('/api/admin/shops/:id/toggle-exempt', requireAdmin, (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    const newExempt = shop.payment_exempt === 1 ? 0 : 1;
    // Quand on exempte une boutique, on la réactive aussi immédiatement
    if (newExempt === 1) {
      db.prepare('UPDATE shops SET payment_exempt = 1, active = 1 WHERE id = ?').run(shop.id);
    } else {
      db.prepare('UPDATE shops SET payment_exempt = 0 WHERE id = ?').run(shop.id);
    }
    res.json({ success: true, payment_exempt: newExempt });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/admin/shops/:id/toggle-setup-fee', requireAdmin, (req, res) => {
  try {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    const newWaive = shop.waive_setup_fee === 1 ? 0 : 1;
    db.prepare('UPDATE shops SET waive_setup_fee = ? WHERE id = ?').run(newWaive, shop.id);
    res.json({ success: true, waive_setup_fee: newWaive });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
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

    const email = (shop.email || req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email gérant requis' });

    // Compter les boutiques actives de ce gérant (même email, insensible à la casse) pour remise multi-boutiques
    const shopCount = db.prepare("SELECT COUNT(*) as count FROM shops WHERE LOWER(TRIM(email)) = ? AND active = 1 AND id != ?").get(email, shop.id);
    const isMulti = shopCount.count >= 1;
    const monthlyPrice = isMulti ? 2400 : 2900; // centimes : 24€ ou 29€

    // Créer ou récupérer le client Stripe
    let stripeCustomerId = shop.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({ email, name: shop.name, metadata: { shop_id: String(shop.id) } });
      stripeCustomerId = customer.id;
      db.prepare('UPDATE shops SET stripe_customer_id = ?, email = ? WHERE id = ?').run(stripeCustomerId, email, shop.id);
    }

    // Créer session Stripe Checkout : 80€ installation (sauf si exemptée) + abonnement mensuel
    const lineItems = [];
    if (shop.waive_setup_fee !== 1) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Installation FidélyPass — ' + shop.name },
          unit_amount: 8000, // 80€
        },
        quantity: 1,
      });
    }
    lineItems.push({
      price_data: {
        currency: 'eur',
        product_data: { name: 'Abonnement FidélyPass mensuel' + (isMulti ? ' (tarif multi-boutiques)' : '') },
        unit_amount: monthlyPrice,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    });

    const session = await getStripe().checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: lineItems,
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

// ─────────────────────────────────────────────
// RELANCE CLIENTS INACTIFS (30 jours sans visite)
// ─────────────────────────────────────────────

async function checkInactiveCustomers() {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const inactive = db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.logo_base64
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.last_visit IS NOT NULL
        AND julianday('now') - julianday(c.last_visit) >= 30
        AND (c.last_reminder_sent IS NULL OR c.last_reminder_sent < c.last_visit)
    `).all();

    for (const customer of inactive) {
      const subs = db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(customer.id);
      if (!subs.length) continue;
      const payload = JSON.stringify({
        title: `👋 ${customer.shop_name}`,
        body: `On ne vous a pas vu depuis 30 jours ! Il vous reste ${customer.points}/${customer.points_goal} points pour : ${customer.reward_text} 🎁`,
        url: '/card/' + customer.id,
        icon: shopIconUrl(customer.logo_base64, customer.shop_id)
      });
      for (const sub of subs) {
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        ).catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          }
        });
      }
      db.prepare('UPDATE customers SET last_reminder_sent = CURRENT_TIMESTAMP WHERE id = ?').run(customer.id);
    }
    if (inactive.length) console.log('Relance clients inactifs envoyée à', inactive.length, 'client(s)');
  } catch (err) {
    console.log('Erreur relance clients inactifs:', err.message);
  }
}

// Vérifie une première fois 2 minutes après le démarrage, puis toutes les 24h
setTimeout(checkInactiveCustomers, 2 * 60 * 1000);
setInterval(checkInactiveCustomers, 24 * 60 * 60 * 1000);

app.listen(PORT, () => console.log('FidelyPass tourne sur http://localhost:' + PORT));// redeploy trigger
// redeploy trigger
