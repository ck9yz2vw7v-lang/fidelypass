const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('./database');

const app = express();
app.set('trust proxy', 1);
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
  webpush.setVapidDetails('mailto:walyd.benaissi@icloud.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// Sessions
const sessions = {};

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function saveSession(token, shopId) {
  sessions[token] = shopId;
  try { await db.prepare('INSERT INTO sessions_store (token, shop_id) VALUES (?, ?) ON CONFLICT (token) DO UPDATE SET shop_id = EXCLUDED.shop_id').run(token, shopId); } catch(e) {}
}

async function deleteSession(token) {
  delete sessions[token];
  try { await db.prepare('DELETE FROM sessions_store WHERE token = ?').run(token); } catch(e) {}
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

async function ensurePassAuthToken(customerId) {
  const customer = await db.prepare('SELECT pass_auth_token FROM customers WHERE id = ?').get(customerId);
  if (customer && customer.pass_auth_token) return customer.pass_auth_token;
  const token = crypto.randomBytes(20).toString('hex');
  await db.prepare('UPDATE customers SET pass_auth_token = ? WHERE id = ?').run(token, customerId);
  return token;
}

// Marque la carte d'un client comme mise à jour, et pousse une notification Apple Wallet aux appareils enregistrés
async function touchPassAndPush(customerId) {
  try {
    await db.prepare('UPDATE customers SET pass_updated_at = ? WHERE id = ?').run(new Date().toISOString(), customerId);
    const serialNumber = 'fidelypass-' + customerId;
    const regs = await db.prepare('SELECT push_token FROM apple_pass_registrations WHERE serial_number = ?').all(serialNumber);
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

// Route de migration UNIQUE : transfère les données de l'ancienne base SQLite vers la
// nouvelle base PostgreSQL. À appeler une seule fois après avoir ajouté PostgreSQL sur
// Railway, avant de considérer la bascule comme terminée. Peut être supprimée ensuite.
app.post('/api/admin/migrate-to-postgres', requireAdmin, async (req, res) => {
  const path = require('path');
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    return res.status(500).json({ success: false, error: "Impossible de charger l'ancienne base (better-sqlite3 manquant) : " + e.message });
  }

  const sqlitePath = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'fidelypass.db')
    : path.join(__dirname, 'fidelypass.db');

  let oldDb;
  try {
    oldDb = new Database(sqlitePath, { readonly: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Ancienne base introuvable à ' + sqlitePath + ' : ' + e.message });
  }

  const summary = {};
  try {
    const tables = [
      { name: 'shops', columns: ['id','name','slug','password','reward_text','points_per_euro','points_goal','color','created_at','referral_bonus_points','google_review_url','stripe_customer_id','stripe_subscription_id','active','email','payment_exempt','waive_setup_fee','currency','menu_url','menu_file_base64','menu_file_type','latitude','longitude','logo_base64','phone','opening_hours','manual_shop_count'] },
      { name: 'customers', columns: ['id','shop_id','name','points','total_visits','created_at','last_visit','last_reminder_sent','referred_by','pass_auth_token','pass_updated_at'] },
      { name: 'scans', columns: ['id','customer_id','shop_id','points_added','scanned_at'] },
      { name: 'push_subscriptions', columns: ['id','customer_id','endpoint','p256dh','auth','created_at'] },
      { name: 'apple_pass_registrations', columns: ['id','device_library_id','pass_type_id','serial_number','push_token','created_at'] },
      { name: 'sessions_store', columns: ['token','shop_id','created_at'] },
      { name: 'leads', columns: ['id','business_name','phone','seen','created_at'] },
      { name: 'admin_subscriptions', columns: ['id','endpoint','p256dh','auth','created_at'] },
    ];

    for (const table of tables) {
      let oldColumns;
      try {
        oldColumns = oldDb.prepare(`PRAGMA table_info(${table.name})`).all().map(c => c.name);
      } catch (e) {
        summary[table.name] = 'table absente dans l\'ancienne base, ignorée';
        continue;
      }
      const usableColumns = table.columns.filter(c => oldColumns.includes(c));
      const rows = oldDb.prepare(`SELECT ${usableColumns.join(', ')} FROM ${table.name}`).all();

      let inserted = 0;
      for (const row of rows) {
        const placeholders = usableColumns.map(() => '?').join(', ');
        const values = usableColumns.map(c => row[c]);
        try {
          await db.prepare(
            `INSERT INTO ${table.name} (${usableColumns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
          ).run(...values);
          inserted++;
        } catch (e) {
          console.error(`Migration ${table.name} id=${row.id || row.token}:`, e.message);
        }
      }
      summary[table.name] = `${inserted}/${rows.length} lignes migrées`;

      // Recale la séquence auto-increment Postgres pour éviter des collisions d'id plus tard
      if (usableColumns.includes('id')) {
        try {
          await db.exec(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), COALESCE((SELECT MAX(id) FROM ${table.name}), 1))`);
        } catch (e) {}
      }
    }

    oldDb.close();
    res.json({ success: true, summary });
  } catch (err) {
    try { oldDb.close(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message, summary });
  }
});

app.post('/api/shops', async (req, res) => {
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, phone, opening_hours, risk_threshold_days, lost_threshold_days, manual_shop_count, booking_enabled } = req.body;
  try {
    const menuFile = parseDataUrl(menu_file_base64);
    const hashedPassword = await bcrypt.hash(password, 10);
    const stmt = await db.prepare(`INSERT INTO shops (name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, menu_file_type, phone, opening_hours, risk_threshold_days, lost_threshold_days, manual_shop_count, booking_enabled, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING id`);
    const result = await stmt.run(name, slug, hashedPassword, reward_text, points_per_euro || 1, points_goal, color, google_review_url || null, email || null, referral_bonus_points != null ? referral_bonus_points : 10, currency || 'EUR', menu_url || null, latitude != null && latitude !== '' ? parseFloat(latitude) : null, longitude != null && longitude !== '' ? parseFloat(longitude) : null, logo_base64 || null, menuFile ? menuFile.base64 : null, menuFile ? menuFile.mime : null, phone || null, opening_hours || null, risk_threshold_days ? parseInt(risk_threshold_days, 10) : 30, lost_threshold_days ? parseInt(lost_threshold_days, 10) : 60, manual_shop_count ? parseInt(manual_shop_count, 10) : null, booking_enabled ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/shops', async (req, res) => {
  const shops = await db.prepare('SELECT * FROM shops').all();
  // On n'envoie pas les logos/fichiers menu en entier dans la liste (potentiellement plusieurs Mo
  // par boutique) — juste un indicateur de présence. Le détail complet est chargé à la demande
  // via /api/admin/shops/:id/full au moment d'ouvrir la modale de modification.
  const light = shops.map(s => {
    const { logo_base64, menu_file_base64, ...rest } = s;
    return { ...rest, has_logo: !!logo_base64, has_menu_file: !!menu_file_base64 };
  });
  res.json(light);
});

app.get('/api/admin/shops/:id/full', requireAdmin, async (req, res) => {
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });
  res.json(shop);
});

app.post('/api/shops/login', loginLimiter, async (req, res) => {
  const { slug, password } = req.body;
  const shop = await db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
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
      await db.prepare('UPDATE shops SET password = ? WHERE id = ?').run(hashed, shop.id);
    }
  }

  if (!valid) return res.status(401).json({ success: false, error: 'Identifiants incorrects' });
  if (shop.active === 0 && shop.payment_exempt !== 1) return res.status(403).json({ success: false, error: 'Boutique suspendue — paiement en attente' });

  const token = generateToken();
  await saveSession(token, shop.id);
  res.json({ success: true, shop, token });
});

app.get('/api/shops/:id/stats', requireShopAuth, async (req, res) => {
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  const customers = await db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ?').get(req.params.id);
  const scans = await db.prepare('SELECT COUNT(*) as count FROM scans WHERE shop_id = ?').get(req.params.id);
  const rewards = await db.prepare("SELECT COUNT(*) as count FROM scans WHERE shop_id = ? AND points_added = 0").get(req.params.id);
  res.json({ shop, total_customers: Number(customers.count), total_scans: Number(scans.count), total_rewards: Number(rewards.count) });
});

// Statistiques avancées : rétention, VIP, fréquentation, croissance — pour aider
// le gérant à ajuster sa stratégie (relances, offres ciblées, horaires de notif)
app.get('/api/shops/:id/analytics', requireShopAuth, async (req, res) => {
  const shopId = req.params.id;
  const shop = await db.prepare('SELECT points_goal, points_per_euro, risk_threshold_days, lost_threshold_days FROM shops WHERE id = ?').get(shopId);
  const goal = (shop && shop.points_goal) ? Number(shop.points_goal) : 0;
  const pointsPerEuro = (shop && shop.points_per_euro) ? Number(shop.points_per_euro) : 1;
  const riskDays = (shop && shop.risk_threshold_days) ? Number(shop.risk_threshold_days) : 30;
  const lostDays = (shop && shop.lost_threshold_days) ? Number(shop.lost_threshold_days) : 60;

  // 1. Santé du portefeuille — score de risque PERSONNALISÉ : on compare le nombre de jours
  // depuis la dernière visite de CHAQUE client à SON PROPRE rythme moyen habituel (calculé à
  // partir de l'écart moyen entre ses visites), pas un seuil fixe de 30 jours pour tout le monde.
  // Un client qui vient tous les 3 jours et n'est pas revenu depuis 8 jours est déjà "à risque",
  // alors qu'un client qui vient tous les 45 jours ne l'est pas encore à ce stade.
  // Sous 3 visites, pas assez d'historique pour un rythme fiable : on retombe sur la règle à 30/60 jours.
  const riskRows = await db.prepare(`
    WITH intervals AS (
      SELECT customer_id,
             EXTRACT(EPOCH FROM (scanned_at - LAG(scanned_at) OVER (PARTITION BY customer_id ORDER BY scanned_at))) / 86400.0 as gap_days
      FROM scans WHERE shop_id = ?
    ),
    avg_rhythm AS (
      SELECT customer_id, AVG(gap_days) as avg_gap, COUNT(*) as nb_gaps
      FROM intervals WHERE gap_days IS NOT NULL
      GROUP BY customer_id
    )
    SELECT c.id, c.name, c.points, c.total_visits,
           COALESCE(c.last_visit, c.created_at) as last_seen,
           EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_visit, c.created_at))) / 86400.0 as days_since,
           r.avg_gap, r.nb_gaps
    FROM customers c
    LEFT JOIN avg_rhythm r ON r.customer_id = c.id
    WHERE c.shop_id = ?
  `).all(shopId, shopId);
  let activeCount = 0, atRiskCount = 0, lostCount = 0;
  const atRiskList = [];
  for (const c of riskRows) {
    const daysSince = Number(c.days_since);
    let status;
    if (c.nb_gaps >= 2 && c.avg_gap > 0) {
      // Rythme personnel connu : à risque dès 1.5x son intervalle habituel, perdu dès 3x
      const personalGap = Number(c.avg_gap);
      if (daysSince <= personalGap * 1.5) status = 'active';
      else if (daysSince <= personalGap * 3) status = 'at_risk';
      else status = 'lost';
    } else {
      // Pas assez d'historique pour un rythme personnel fiable : on retombe sur les seuils
      // fixés par l'admin pour CETTE boutique (par défaut 30/60 jours si jamais configurés).
      if (daysSince <= riskDays) status = 'active';
      else if (daysSince <= lostDays) status = 'at_risk';
      else status = 'lost';
    }
    if (status === 'active') activeCount++;
    else if (status === 'at_risk') { atRiskCount++; atRiskList.push({ id: c.id, name: c.name, points: c.points, total_visits: c.total_visits, last_seen: c.last_seen, personal_rhythm_days: c.avg_gap ? Math.round(Number(c.avg_gap)) : null }); }
    else lostCount++;
  }
  atRiskList.sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));

  // 2. Meilleurs clients
  const topByVisits = await db.prepare('SELECT id, name, total_visits, points FROM customers WHERE shop_id = ? ORDER BY total_visits DESC LIMIT 10').all(shopId);
  const topByPoints = await db.prepare('SELECT id, name, total_visits, points FROM customers WHERE shop_id = ? ORDER BY points DESC LIMIT 10').all(shopId);
  const avgStats = await db.prepare('SELECT AVG(total_visits) as avg_visits, AVG(points) as avg_points FROM customers WHERE shop_id = ?').get(shopId);

  // 2bis. Panier moyen, valeur client (LTV) et évolution du panier sur 8 semaines
  const basketStats = await db.prepare(`
    SELECT AVG(amount_paid) as avg_basket, SUM(amount_paid) as total_revenue, COUNT(*) FILTER (WHERE amount_paid > 0) as paid_scans
    FROM scans WHERE shop_id = ? AND amount_paid IS NOT NULL AND amount_paid > 0
  `).get(shopId);
  const basketByWeek = await db.prepare(`
    SELECT DATE_TRUNC('week', scanned_at)::date as week, AVG(amount_paid) as avg_basket
    FROM scans WHERE shop_id = ? AND amount_paid > 0 AND scanned_at >= NOW() - INTERVAL '8 weeks'
    GROUP BY week ORDER BY week
  `).all(shopId);
  const ltvRows = await db.prepare(`
    SELECT c.id, COALESCE(SUM(s.amount_paid), 0) as total_spent,
           EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400.0 as days_since_signup
    FROM customers c LEFT JOIN scans s ON s.customer_id = c.id AND s.amount_paid > 0
    WHERE c.shop_id = ? GROUP BY c.id, c.created_at
  `).all(shopId);
  const avgLtv = ltvRows.length > 0 ? ltvRows.reduce((sum, r) => sum + Number(r.total_spent), 0) / ltvRows.length : 0;
  const avgCustomerAgeDays = ltvRows.length > 0 ? ltvRows.reduce((sum, r) => sum + Number(r.days_since_signup), 0) / ltvRows.length : 0;
  const projectedAnnualLtv = avgCustomerAgeDays > 0 ? (avgLtv / avgCustomerAgeDays) * 365 : 0;

  // 3. Fréquentation : par jour de semaine, par heure, et grille combinée jour × heure
  const byDow = await db.prepare(`
    SELECT EXTRACT(DOW FROM scanned_at)::int as dow, COUNT(*) as count
    FROM scans WHERE shop_id = ? GROUP BY dow ORDER BY dow
  `).all(shopId);
  const byHour = await db.prepare(`
    SELECT EXTRACT(HOUR FROM scanned_at)::int as hour, COUNT(*) as count
    FROM scans WHERE shop_id = ? GROUP BY hour ORDER BY hour
  `).all(shopId);
  const heatmap = await db.prepare(`
    SELECT EXTRACT(DOW FROM scanned_at)::int as dow, EXTRACT(HOUR FROM scanned_at)::int as hour, COUNT(*) as count
    FROM scans WHERE shop_id = ? GROUP BY dow, hour
  `).all(shopId);

  // 4. Croissance : nouveaux clients par semaine (12 dernières semaines)
  const growth = await db.prepare(`
    SELECT DATE_TRUNC('week', created_at)::date as week, COUNT(*) as count
    FROM customers WHERE shop_id = ? AND created_at >= NOW() - INTERVAL '12 weeks'
    GROUP BY week ORDER BY week
  `).all(shopId);

  const referralCount = await db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ? AND referred_by IS NOT NULL').get(shopId);
  const reachedGoal = goal > 0
    ? await db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ? AND points >= ?').get(shopId, goal)
    : { count: 0 };

  // 5. Comparaison réseau (anonymisée) — moyenne de TOUTES les boutiques actives sur FidélyPass,
  // pour situer cette boutique par rapport à l'ensemble, sans jamais révéler qui sont les autres.
  const networkAvg = await db.prepare(`
    WITH per_shop AS (
      SELECT s.id,
             COUNT(c.id) FILTER (WHERE COALESCE(c.last_visit, c.created_at) >= NOW() - INTERVAL '30 days') as active,
             COUNT(c.id) as total
      FROM shops s LEFT JOIN customers c ON c.shop_id = s.id
      WHERE s.active = 1
      GROUP BY s.id
      HAVING COUNT(c.id) >= 3
    )
    SELECT AVG(CASE WHEN total > 0 THEN (active::float / total) * 100 ELSE NULL END) as avg_retention_rate,
           COUNT(*) as shops_compared
    FROM per_shop
  `).get();

  // 6. Multi-boutiques du même gérant (regroupées par email) — vue consolidée si applicable
  const shopEmail = await db.prepare('SELECT LOWER(TRIM(email)) as email FROM shops WHERE id = ?').get(shopId);
  let multiShop = null;
  if (shopEmail && shopEmail.email) {
    const siblingShops = await db.prepare(`
      SELECT s.id, s.name,
             (SELECT COUNT(*) FROM customers WHERE shop_id = s.id) as customers_count,
             (SELECT COUNT(*) FROM scans WHERE shop_id = s.id) as scans_count
      FROM shops s WHERE LOWER(TRIM(s.email)) = ? AND s.active = 1
      ORDER BY s.name
    `).all(shopEmail.email);
    if (siblingShops.length > 1) {
      multiShop = siblingShops.map(s => ({ id: s.id, name: s.name, customers: Number(s.customers_count), scans: Number(s.scans_count) }));
    }
  }

  const total = riskRows.length;
  res.json({
    health: {
      active: activeCount, at_risk: atRiskCount, lost: lostCount, total,
      retention_rate: total > 0 ? Math.round((activeCount / total) * 1000) / 10 : 0,
      risk_threshold_days: riskDays, lost_threshold_days: lostDays
    },
    at_risk_customers: atRiskList.slice(0, 20),
    top_by_visits: topByVisits,
    top_by_points: topByPoints,
    avg_visits: avgStats.avg_visits ? Math.round(Number(avgStats.avg_visits) * 10) / 10 : 0,
    avg_points: avgStats.avg_points ? Math.round(Number(avgStats.avg_points) * 10) / 10 : 0,
    avg_basket: basketStats.avg_basket ? Math.round(Number(basketStats.avg_basket) * 100) / 100 : null,
    total_revenue_tracked: basketStats.total_revenue ? Math.round(Number(basketStats.total_revenue) * 100) / 100 : 0,
    basket_by_week: basketByWeek.map(r => ({ week: r.week, avg_basket: r.avg_basket ? Math.round(Number(r.avg_basket) * 100) / 100 : 0 })),
    avg_ltv: Math.round(avgLtv * 100) / 100,
    projected_annual_ltv: Math.round(projectedAnnualLtv * 100) / 100,
    frequency_by_dow: byDow.map(r => ({ dow: r.dow, count: Number(r.count) })),
    frequency_by_hour: byHour.map(r => ({ hour: r.hour, count: Number(r.count) })),
    heatmap: heatmap.map(r => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
    growth_by_week: growth.map(r => ({ week: r.week, count: Number(r.count) })),
    referral_count: Number(referralCount.count),
    referral_rate: total > 0 ? Math.round((Number(referralCount.count) / total) * 1000) / 10 : 0,
    goal_reached_count: Number(reachedGoal.count),
    goal_reached_rate: (total > 0 && goal > 0) ? Math.round((Number(reachedGoal.count) / total) * 1000) / 10 : 0,
    network_benchmark: {
      your_retention_rate: total > 0 ? Math.round((activeCount / total) * 1000) / 10 : 0,
      network_avg_retention_rate: networkAvg.avg_retention_rate ? Math.round(Number(networkAvg.avg_retention_rate) * 10) / 10 : null,
      shops_compared: Number(networkAvg.shops_compared) || 0
    },
    multi_shop: multiShop
  });
});

// Export CSV des clients — pour la compta, un partenaire, ou juste garder une trace hors plateforme
app.get('/api/shops/:id/export-customers.csv', requireShopAuth, async (req, res) => {
  const shopId = req.params.id;
  const customers = await db.prepare(`
    SELECT name, points, total_visits, reward_cycles_completed, created_at, COALESCE(last_visit, created_at) as last_visit
    FROM customers WHERE shop_id = ? ORDER BY created_at ASC
  `).all(shopId);
  const header = 'Nom,Points,Visites totales,Récompenses obtenues,Date inscription,Dernière visite\n';
  const rows = customers.map(c => {
    const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    return [esc(c.name), c.points, c.total_visits, c.reward_cycles_completed || 0, new Date(c.created_at).toLocaleDateString('fr-FR'), new Date(c.last_visit).toLocaleDateString('fr-FR')].join(',');
  }).join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="clients-fidelypass.csv"');
  res.send('\uFEFF' + header + rows);
});

// Vérifie s'il y a des clients à risque et dépose une alerte dans la boîte de réception du
// gérant (même système que la messagerie admin → gérants déjà en place) — déclenchable
// manuellement ("Vérifier maintenant") ou automatiquement une fois par semaine (voir le
// minuteur plus bas dans le fichier), sans dépendre d'un service d'email externe.
async function runProactiveDigest(shopId) {
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(shopId);
  if (!shop) return { sent: false, reason: 'shop introuvable' };
  const atRisk = await db.prepare(`
    SELECT COUNT(*) as count FROM customers
    WHERE shop_id = ? AND COALESCE(last_visit, created_at) < NOW() - INTERVAL '14 days' AND COALESCE(last_visit, created_at) >= NOW() - INTERVAL '60 days'
  `).get(shopId);
  const count = Number(atRisk.count);
  await db.prepare('UPDATE shops SET last_digest_sent_at = NOW() WHERE id = ?').run(shopId);
  if (count === 0) return { sent: false, reason: 'aucun client à risque' };

  const title = '📊 Alerte hebdomadaire : ' + count + ' client' + (count > 1 ? 's' : '') + ' à risque';
  const body = 'Vous avez ' + count + ' client' + (count > 1 ? 's' : '') + ' qui n\'' + (count > 1 ? 'ont' : 'a') + ' pas visité depuis 14 à 60 jours. Consultez vos statistiques pour les identifier et les relancer.';
  await db.prepare("INSERT INTO admin_messages (title, body, target_shop_id, source) VALUES (?, ?, ?, 'digest')").run(title, body, shopId);
  return { sent: true, at_risk_count: count };
}

app.post('/api/shops/:id/run-digest', requireShopAuth, async (req, res) => {
  const result = await runProactiveDigest(req.params.id);
  res.json(result);
});

app.post('/api/customers', async (req, res) => {
  const { shop_id, name, ref } = req.body;
  try {
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
    if (!shop) return res.status(400).json({ success: false, error: 'Boutique introuvable' });

    // Vérifie que le parrain est un client valide de la même boutique
    let referrer = null;
    if (ref) {
      referrer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(ref, shop_id);
    }
    const bonus = shop.referral_bonus_points || 0;
    const startingPoints = referrer ? bonus : 0;

    const stmt = await db.prepare('INSERT INTO customers (shop_id, name, points, referred_by) VALUES (?, ?, ?, ?) RETURNING id');
    const result = await stmt.run(shop_id, name, startingPoints, referrer ? referrer.id : null);
    res.json({ success: true, id: result.lastInsertRowid, bonus_received: startingPoints });

    // Récompense le parrain + le notifie
    if (referrer && bonus > 0) {
      await db.prepare('UPDATE customers SET points = points + ? WHERE id = ?').run(bonus, referrer.id);
      if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
        const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(referrer.id);
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
          ).catch(async err => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
            }
          });
        }
      }
    }
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/customers/:id', async (req, res) => {
  const customer = await db.prepare(`
    SELECT c.*, s.points_goal, s.reward_text, s.google_review_url, s.color, s.slug, s.name as shop_name, s.referral_bonus_points,
           s.menu_url, s.phone, s.opening_hours, (s.menu_file_base64 IS NOT NULL) as has_menu_file
    FROM customers c JOIN shops s ON s.id = c.shop_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Client introuvable' });
  if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
  customer.reward_tiers = await db.prepare('SELECT id, threshold_points, reward_text FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(customer.shop_id);
  res.json(customer);
});

app.get('/api/customers/:id/history', async (req, res) => {
  const history = await db.prepare(`
    SELECT points_added, scanned_at, is_manual FROM scans
    WHERE customer_id = ? ORDER BY scanned_at DESC LIMIT 10
  `).all(req.params.id);
  res.json(history);
});

app.put('/api/customers/:id/points', requireShopAuth, async (req, res) => {
  const { points, shop_id } = req.body;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  const diff = Number(points) - Number(customer.points);
  await db.prepare('UPDATE customers SET points = ? WHERE id = ?').run(points, req.params.id);
  if (diff !== 0) {
    await db.prepare('INSERT INTO scans (customer_id, shop_id, points_added, is_manual) VALUES (?, ?, ?, 1)').run(req.params.id, shop_id, diff);
  }
  res.json({ success: true });
});

app.delete('/api/customers/:id', requireShopAuth, async (req, res) => {
  const { shop_id } = req.body;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  await db.prepare('DELETE FROM scans WHERE customer_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM apple_pass_registrations WHERE serial_number = ?').run('fidelypass-' + req.params.id);
  await db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/scan', requireShopAuth, async (req, res) => {
  const { customer_id, shop_id, amount } = req.body;
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(customer_id, shop_id);
  if (!shop || !customer) return res.status(404).json({ success: false, error: 'Introuvable' });
  const pointsPerEuro = shop.points_per_euro || 1;
  const pointsEarned = Math.floor((amount || 0) * pointsPerEuro);
  const newPoints = customer.points + pointsEarned;
  const tiers = await db.prepare('SELECT * FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(shop_id);
  // Palier fraîchement débloqué par ce scan (le plus haut atteint qui ne l'était pas avant)
  const newlyCrossedTier = tiers.length > 0
    ? [...tiers].reverse().find(t => newPoints >= t.threshold_points && customer.points < t.threshold_points)
    : null;
  const rewardUnlocked = tiers.length > 0
    ? tiers.some(t => newPoints >= t.threshold_points)
    : newPoints >= shop.points_goal;
  // Objectif et récompense "effectifs" renvoyés au gérant : reste sur le palier le PLUS HAUT
  // configuré (pas le plus petit) quand des paliers existent, sinon l'ancien objectif unique.
  const effectiveGoal = tiers.length > 0 ? tiers[tiers.length - 1].threshold_points : shop.points_goal;
  const effectiveRewardText = tiers.length > 0
    ? (newlyCrossedTier ? newlyCrossedTier.reward_text : tiers[tiers.length - 1].reward_text)
    : shop.reward_text;
  await db.prepare('UPDATE customers SET points = ?, total_visits = total_visits + 1, last_visit = CURRENT_TIMESTAMP WHERE id = ?').run(newPoints, customer_id);
  await db.prepare('INSERT INTO scans (customer_id, shop_id, points_added, amount_paid) VALUES (?, ?, ?, ?)').run(customer_id, shop_id, pointsEarned, amount || 0);
  touchPassAndPush(customer_id);
  res.json({ success: true, customer_name: customer.name, points_before: customer.points, points_after: newPoints, points_added: pointsEarned, amount_paid: amount, reward_unlocked: rewardUnlocked, reward_text: effectiveRewardText, points_goal: effectiveGoal, google_review_url: shop.google_review_url || null });

  // Notifie le client par push : récompense (ou palier) débloqué, ou simple progression
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(customer_id);
    let payload;
    if (newlyCrossedTier) {
      const body = shop.google_review_url
        ? `Vous avez débloqué : ${newlyCrossedTier.reward_text} 🎁 Laissez un avis pour le récupérer !`
        : `Vous avez débloqué : ${newlyCrossedTier.reward_text} 🎁 Montrez cet écran au gérant !`;
      payload = JSON.stringify({ title: `🎉 ${shop.name}`, body, url: '/card/' + customer_id, icon: shopIconUrl(shop.logo_base64, shop.id) });
    } else if (rewardUnlocked) {
      const body = shop.google_review_url
        ? `Vous avez débloqué : ${shop.reward_text} 🎁 Laissez un avis pour le récupérer !`
        : `Vous avez débloqué : ${shop.reward_text} 🎁 Montrez cet écran au gérant !`;
      payload = JSON.stringify({ title: `🎉 ${shop.name}`, body, url: '/card/' + customer_id, icon: shopIconUrl(shop.logo_base64, shop.id) });
    } else if (tiers.length > 0) {
      const nextTier = tiers.find(t => newPoints < t.threshold_points);
      const remaining = nextTier ? nextTier.threshold_points - newPoints : 0;
      payload = JSON.stringify({
        title: `🎯 ${shop.name}`,
        body: nextTier ? `Vous avez ${newPoints} points. Encore ${remaining} pts pour : ${nextTier.reward_text} 🎁` : `Vous avez ${newPoints} points !`,
        url: '/card/' + customer_id,
        icon: shopIconUrl(shop.logo_base64, shop.id)
      });
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
      ).catch(async err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        }
      });
    }
  }
});

app.post('/api/reward/:customer_id', requireShopAuth, async (req, res) => {
  const { shop_id } = req.body;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.customer_id, shop_id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(shop_id);
  await db.prepare('UPDATE customers SET points = 0, reward_cycles_completed = reward_cycles_completed + 1 WHERE id = ?').run(req.params.customer_id);
  await db.prepare('INSERT INTO scans (customer_id, shop_id, points_added) VALUES (?, ?, ?)').run(req.params.customer_id, shop_id, 0);
  touchPassAndPush(req.params.customer_id);
  res.json({ success: true, google_review_url: shop.google_review_url || null });
});

app.get('/api/shops/:shop_id/customers', requireShopAuth, async (req, res) => {
  const shopId = req.params.shop_id;
  const shopThresholds = await db.prepare('SELECT risk_threshold_days, lost_threshold_days FROM shops WHERE id = ?').get(shopId);
  const riskDays = (shopThresholds && shopThresholds.risk_threshold_days) ? Number(shopThresholds.risk_threshold_days) : 30;
  const lostDays = (shopThresholds && shopThresholds.lost_threshold_days) ? Number(shopThresholds.lost_threshold_days) : 60;
  // Même logique de statut personnalisé que la page Statistiques : on compare le nombre de
  // jours depuis la dernière visite de CHAQUE client à SON PROPRE rythme moyen habituel.
  const customers = await db.prepare(`
    WITH intervals AS (
      SELECT customer_id,
             EXTRACT(EPOCH FROM (scanned_at - LAG(scanned_at) OVER (PARTITION BY customer_id ORDER BY scanned_at))) / 86400.0 as gap_days
      FROM scans WHERE shop_id = ?
    ),
    avg_rhythm AS (
      SELECT customer_id, AVG(gap_days) as avg_gap, COUNT(*) as nb_gaps
      FROM intervals WHERE gap_days IS NOT NULL
      GROUP BY customer_id
    )
    SELECT c.*,
           EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_visit, c.created_at))) / 86400.0 as days_since_visit,
           r.avg_gap, r.nb_gaps,
           EXISTS(SELECT 1 FROM push_subscriptions ps WHERE ps.customer_id = c.id) as has_push
    FROM customers c
    LEFT JOIN avg_rhythm r ON r.customer_id = c.id
    WHERE c.shop_id = ?
    ORDER BY c.points DESC
  `).all(shopId, shopId);

  for (const c of customers) {
    const daysSince = Number(c.days_since_visit);
    if (c.nb_gaps >= 2 && c.avg_gap > 0) {
      const personalGap = Number(c.avg_gap);
      if (daysSince <= personalGap * 1.5) c.status = 'active';
      else if (daysSince <= personalGap * 3) c.status = 'at_risk';
      else c.status = 'lost';
    } else {
      if (daysSince <= riskDays) c.status = 'active';
      else if (daysSince <= lostDays) c.status = 'at_risk';
      else c.status = 'lost';
    }
    delete c.avg_gap; delete c.nb_gaps; delete c.days_since_visit;
  }

  res.json(customers);
});

app.get('/api/customers/:id/qr', async (req, res) => {
  const url = 'fidelypass:customer:' + req.params.id;
  const qr = await QRCode.toDataURL(url);
  res.json({ qr });
});

app.get('/api/customers/:id/wallet', async (req, res) => {
  try {
    const customer = await db.prepare(`
      SELECT c.*, s.id as shop_id, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.google_review_url, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Client introuvable' });
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    customer.reward_tiers = await db.prepare('SELECT threshold_points, reward_text FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(customer.shop_id);
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

async function checkApplePassAuth(req, customerId) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('ApplePass ') ? header.slice('ApplePass '.length) : null;
  if (!token) return false;
  const customer = await db.prepare('SELECT pass_auth_token FROM customers WHERE id = ?').get(customerId);
  return !!customer && customer.pass_auth_token === token;
}

// Enregistrement d'un appareil pour recevoir les mises à jour push d'une carte
app.post('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
  const customerId = customerIdFromSerial(serialNumber);
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
  if (!await checkApplePassAuth(req, customerId)) return res.status(401).end();
  const pushToken = req.body && req.body.pushToken;
  if (!pushToken) return res.status(400).end();
  const existing = await db.prepare('SELECT id FROM apple_pass_registrations WHERE device_library_id = ? AND serial_number = ?').get(deviceLibraryIdentifier, serialNumber);
  if (existing) {
    await db.prepare('UPDATE apple_pass_registrations SET push_token = ? WHERE id = ?').run(pushToken, existing.id);
    return res.status(200).end();
  }
  await db.prepare('INSERT INTO apple_pass_registrations (device_library_id, pass_type_id, serial_number, push_token) VALUES (?, ?, ?, ?)')
    .run(deviceLibraryIdentifier, passTypeIdentifier, serialNumber, pushToken);
  res.status(201).end();
});

// Désenregistrement d'un appareil
app.delete('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier, serialNumber } = req.params;
  const customerId = customerIdFromSerial(serialNumber);
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
  if (!await checkApplePassAuth(req, customerId)) return res.status(401).end();
  await db.prepare('DELETE FROM apple_pass_registrations WHERE device_library_id = ? AND serial_number = ?').run(deviceLibraryIdentifier, serialNumber);
  res.status(200).end();
});

// Liste des cartes à mettre à jour pour un appareil donné
app.get('/apple-wallet/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', async (req, res) => {
  const { deviceLibraryIdentifier, passTypeIdentifier } = req.params;
  if (passTypeIdentifier !== APPLE_PASS_TYPE_ID) return res.status(404).end();
  const rows = await db.prepare('SELECT serial_number FROM apple_pass_registrations WHERE device_library_id = ?').all(deviceLibraryIdentifier);
  if (!rows.length) return res.status(204).end();
  res.json({ lastUpdated: String(Date.now()), serialNumbers: rows.map(r => r.serial_number) });
});

// Renvoie la carte à jour (appelé par l'iPhone quand une notification push est reçue)
app.get('/apple-wallet/v1/passes/:passTypeIdentifier/:serialNumber', async (req, res) => {
  try {
    const { passTypeIdentifier, serialNumber } = req.params;
    const customerId = customerIdFromSerial(serialNumber);
    if (passTypeIdentifier !== APPLE_PASS_TYPE_ID || !customerId) return res.status(404).end();
    if (!await checkApplePassAuth(req, customerId)) return res.status(401).end();
    const customer = await db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.latitude, s.longitude, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(customerId);
    if (!customer) return res.status(404).end();
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    customer.pass_auth_token = await ensurePassAuthToken(customer.id);
    customer.reward_tiers = await db.prepare('SELECT threshold_points, reward_text FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(customer.shop_id);
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
    const customer = await db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.color,
             s.menu_url, s.latitude, s.longitude, s.logo_base64, s.phone, s.opening_hours,
             (s.menu_file_base64 IS NOT NULL) as has_menu_file
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.id = ?
    `).get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Client introuvable' });
    if (customer.has_menu_file) customer.menu_url = 'https://fidelypass-production.up.railway.app/shops/' + customer.shop_id + '/menu-file';
    customer.pass_auth_token = await ensurePassAuthToken(customer.id);
    customer.reward_tiers = await db.prepare('SELECT threshold_points, reward_text FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(customer.shop_id);
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

app.post('/api/customers/:id/subscribe', async (req, res) => {
  const { subscription } = req.body;
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ success: false, error: 'Abonnement invalide' });
  }
  try {
    // Évite les doublons pour le même endpoint
    await db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ? AND endpoint = ?')
      .run(req.params.id, subscription.endpoint);
    await db.prepare('INSERT INTO push_subscriptions (customer_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
      .run(req.params.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/customers/:id/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  try {
    if (endpoint) {
      await db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ? AND endpoint = ?').run(req.params.id, endpoint);
    } else {
      await db.prepare('DELETE FROM push_subscriptions WHERE customer_id = ?').run(req.params.id);
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
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });

  const subs = await db.prepare(`
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
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }

  res.json({ success: true, sent, failed, total: subs.length });
});

// Gérant : notification ciblée à UN client précis (pas une diffusion à tous les abonnés)
app.post('/api/shops/:id/customers/:customerId/notify', requireShopAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ success: false, error: 'Message vide' });
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ success: false, error: 'Clés VAPID non configurées côté serveur' });
  }
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });

  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(req.params.customerId, req.params.id);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable dans cette boutique' });

  const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(req.params.customerId);
  if (!subs.length) return res.status(404).json({ success: false, error: "Ce client n'a pas activé les notifications" });

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
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      }
    }
  }

  res.json({ success: true, sent, failed });
});

// ─────────────────────────────────────────────
// PRISE DE RENDEZ-VOUS (activable par boutique depuis l'admin)
// ─────────────────────────────────────────────

// Gérant : durée d'un créneau de rendez-vous (route dédiée, plus sûre que la route générale
// de modification de boutique qui n'a pas de vérification d'identité stricte)
app.put('/api/shops/:id/booking-settings', requireShopAuth, async (req, res) => {
  const { booking_slot_minutes } = req.body;
  const minutes = parseInt(booking_slot_minutes, 10);
  if (!minutes || minutes < 5) return res.status(400).json({ success: false, error: 'Durée invalide' });
  await db.prepare('UPDATE shops SET booking_slot_minutes = ? WHERE id = ?').run(minutes, req.params.id);
  res.json({ success: true });
});

// Admin : consulter les prestations d'une boutique (durée + prix fixés par l'équipe FidélyPass)
app.get('/api/admin/shops/:id/services', requireAdmin, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM services WHERE shop_id = ? ORDER BY duration_minutes ASC').all(req.params.id);
  res.json(rows);
});

// Admin : ajouter une prestation
app.post('/api/admin/shops/:id/services', requireAdmin, async (req, res) => {
  const { name, duration_minutes, price } = req.body;
  if (!name || !name.trim() || !duration_minutes || duration_minutes < 5) {
    return res.status(400).json({ success: false, error: 'Nom et durée (minimum 5 min) requis' });
  }
  const result = await db.prepare('INSERT INTO services (shop_id, name, duration_minutes, price) VALUES (?, ?, ?, ?) RETURNING id')
    .run(req.params.id, name.trim(), parseInt(duration_minutes, 10), price ? parseFloat(price) : null);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Admin : retirer une prestation
app.delete('/api/admin/shops/:id/services/:serviceId', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM services WHERE id = ? AND shop_id = ?').run(req.params.serviceId, req.params.id);
  res.json({ success: true });
});

// Gérant : lecture seule de ses prestations (configurées par l'équipe FidélyPass, pas modifiables ici)
app.get('/api/shops/:id/services', requireShopAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM services WHERE shop_id = ? ORDER BY duration_minutes ASC').all(req.params.id);
  res.json(rows);
});

// ─────────────────────────────────────────────
// ÉQUIPE (plusieurs coiffeurs/coiffeuses, chacun avec son propre planning)
// ─────────────────────────────────────────────

// Gérant : consulter son équipe
app.get('/api/shops/:id/staff', requireShopAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM staff_members WHERE shop_id = ? ORDER BY name ASC').all(req.params.id);
  res.json(rows);
});

// Gérant : ajouter un membre d'équipe
app.post('/api/shops/:id/staff', requireShopAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Nom requis' });
  const result = await db.prepare('INSERT INTO staff_members (shop_id, name) VALUES (?, ?) RETURNING id').run(req.params.id, name.trim());
  res.json({ success: true, id: result.lastInsertRowid });
});

// Gérant : retirer un membre d'équipe (et ses créneaux associés)
app.delete('/api/shops/:id/staff/:staffId', requireShopAuth, async (req, res) => {
  await db.prepare('DELETE FROM staff_availability WHERE staff_id = ?').run(req.params.staffId);
  await db.prepare('DELETE FROM staff_members WHERE id = ? AND shop_id = ?').run(req.params.staffId, req.params.id);
  res.json({ success: true });
});

// Client (public) : voir l'équipe avant de choisir avec qui prendre rendez-vous
app.get('/api/shops/:id/staff-public', async (req, res) => {
  const rows = await db.prepare('SELECT id, name FROM staff_members WHERE shop_id = ? ORDER BY name ASC').all(req.params.id);
  res.json(rows);
});

// Gérant : consulter le planning hebdomadaire d'un membre d'équipe précis
app.get('/api/shops/:id/staff/:staffId/availability', requireShopAuth, async (req, res) => {
  const staff = await db.prepare('SELECT id FROM staff_members WHERE id = ? AND shop_id = ?').get(req.params.staffId, req.params.id);
  if (!staff) return res.status(404).json({ error: 'Membre introuvable' });
  const rows = await db.prepare('SELECT * FROM staff_availability WHERE staff_id = ? ORDER BY day_of_week, start_time').all(req.params.staffId);
  res.json(rows);
});

// Gérant : ajouter un créneau au planning d'un membre d'équipe
app.post('/api/shops/:id/staff/:staffId/availability', requireShopAuth, async (req, res) => {
  const staff = await db.prepare('SELECT id FROM staff_members WHERE id = ? AND shop_id = ?').get(req.params.staffId, req.params.id);
  if (!staff) return res.status(404).json({ success: false, error: 'Membre introuvable' });
  const { day_of_week, start_time, end_time } = req.body;
  if (day_of_week == null || !start_time || !end_time) return res.status(400).json({ success: false, error: 'Champs manquants' });
  const result = await db.prepare('INSERT INTO staff_availability (staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?) RETURNING id')
    .run(req.params.staffId, day_of_week, start_time, end_time);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Gérant : retirer un créneau du planning d'un membre d'équipe
app.delete('/api/shops/:id/staff/:staffId/availability/:availId', requireShopAuth, async (req, res) => {
  await db.prepare('DELETE FROM staff_availability WHERE id = ? AND staff_id = ?').run(req.params.availId, req.params.staffId);
  res.json({ success: true });
});

// Gérant : consulter ses créneaux hebdomadaires récurrents
app.get('/api/shops/:id/availability', requireShopAuth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM shop_availability WHERE shop_id = ? ORDER BY day_of_week, start_time').all(req.params.id);
  res.json(rows);
});

// Gérant : ajouter un créneau (ex: Mardi 9h-19h)
app.post('/api/shops/:id/availability', requireShopAuth, async (req, res) => {
  const { day_of_week, start_time, end_time } = req.body;
  if (day_of_week == null || !start_time || !end_time) {
    return res.status(400).json({ success: false, error: 'Champs manquants' });
  }
  const result = await db.prepare('INSERT INTO shop_availability (shop_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?) RETURNING id')
    .run(req.params.id, day_of_week, start_time, end_time);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Gérant : retirer un créneau
app.delete('/api/shops/:id/availability/:availId', requireShopAuth, async (req, res) => {
  await db.prepare('DELETE FROM shop_availability WHERE id = ? AND shop_id = ?').run(req.params.availId, req.params.id);
  res.json({ success: true });
});

// Gérant : liste des rendez-vous à venir
app.get('/api/shops/:id/appointments', requireShopAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT a.*, c.name as customer_name, sv.name as service_name, sv.duration_minutes as service_duration, st.name as staff_name
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN services sv ON sv.id = a.service_id
    LEFT JOIN staff_members st ON st.id = a.staff_id
    WHERE a.shop_id = ? AND a.status = 'confirmed' AND a.appointment_time >= NOW()
    ORDER BY a.appointment_time ASC
  `).all(req.params.id);
  res.json(rows);
});

// Gérant : combien de rendez-vous ont été pris depuis la dernière consultation (pour le badge)
app.get('/api/shops/:id/appointments/unseen-count', requireShopAuth, async (req, res) => {
  const shop = await db.prepare('SELECT last_appointment_seen_at FROM shops WHERE id = ?').get(req.params.id);
  const since = shop && shop.last_appointment_seen_at ? shop.last_appointment_seen_at : '1970-01-01';
  const row = await db.prepare("SELECT COUNT(*) as count FROM appointments WHERE shop_id = ? AND status = 'confirmed' AND created_at > ?").get(req.params.id, since);
  res.json({ count: Number(row.count) });
});

// Gérant : marque tous les rendez-vous comme vus (appelé à l'ouverture de l'écran Rendez-vous)
app.post('/api/shops/:id/appointments/mark-seen', requireShopAuth, async (req, res) => {
  await db.prepare('UPDATE shops SET last_appointment_seen_at = NOW() WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Gérant : annuler un rendez-vous
app.post('/api/shops/:id/appointments/:apptId/cancel', requireShopAuth, async (req, res) => {
  await db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND shop_id = ?").run(req.params.apptId, req.params.id);
  res.json({ success: true });
});

// Calcule les créneaux disponibles pour les N prochains jours à partir des disponibilités
// hebdomadaires récurrentes, en retirant les créneaux déjà pris et ceux déjà passés.
function computeAvailableSlots(availabilityRows, bookedIsoSet, slotMinutes, daysAhead) {
  const now = new Date();
  const byDate = {};
  for (let d = 0; d < daysAhead; d++) {
    const day = new Date(now.getTime() + d * 86400000);
    const dateStr = day.toISOString().slice(0, 10);
    const dow = day.getDay();
    const dayRows = availabilityRows.filter(r => Number(r.day_of_week) === dow);
    const slots = [];
    for (const row of dayRows) {
      const [sh, sm] = row.start_time.split(':').map(Number);
      const [eh, em] = row.end_time.split(':').map(Number);
      let cursor = new Date(dateStr + 'T00:00:00');
      cursor.setHours(sh, sm, 0, 0);
      const end = new Date(dateStr + 'T00:00:00');
      end.setHours(eh, em, 0, 0);
      while (cursor < end) {
        if (cursor > now && !bookedIsoSet.has(cursor.toISOString())) {
          slots.push(cursor.toISOString());
        }
        cursor = new Date(cursor.getTime() + slotMinutes * 60000);
      }
    }
    if (slots.length > 0) byDate[dateStr] = slots;
  }
  return byDate;
}

// Client (public, depuis sa carte) : voir les créneaux disponibles des 14 prochains jours
// Client (public) : voir les prestations proposées avant de choisir un créneau
app.get('/api/shops/:id/services-public', async (req, res) => {
  const rows = await db.prepare('SELECT id, name, duration_minutes, price FROM services WHERE shop_id = ? ORDER BY duration_minutes ASC').all(req.params.id);
  res.json(rows);
});

app.get('/api/shops/:id/available-slots', async (req, res) => {
  const shop = await db.prepare('SELECT booking_enabled, booking_slot_minutes FROM shops WHERE id = ?').get(req.params.id);
  if (!shop || shop.booking_enabled !== 1) return res.status(404).json({ error: 'Rendez-vous non disponibles pour cette boutique' });
  let slotMinutes = shop.booking_slot_minutes || 30;
  if (req.query.service_id) {
    const service = await db.prepare('SELECT duration_minutes FROM services WHERE id = ? AND shop_id = ?').get(req.query.service_id, req.params.id);
    if (service) slotMinutes = service.duration_minutes;
  }
  let availabilityRows, booked;
  if (req.query.staff_id) {
    // Planning propre à ce membre d'équipe, et on ne bloque que SES créneaux déjà pris
    // (deux coiffeurs différents peuvent avoir un rendez-vous au même horaire, c'est normal)
    availabilityRows = await db.prepare('SELECT * FROM staff_availability WHERE staff_id = ?').all(req.query.staff_id);
    booked = await db.prepare("SELECT appointment_time FROM appointments WHERE shop_id = ? AND staff_id = ? AND status = 'confirmed' AND appointment_time >= NOW()").all(req.params.id, req.query.staff_id);
  } else {
    // Pas de coiffeur précisé (boutique sans équipe configurée) : ancien comportement, planning de la boutique
    availabilityRows = await db.prepare('SELECT * FROM shop_availability WHERE shop_id = ?').all(req.params.id);
    booked = await db.prepare("SELECT appointment_time FROM appointments WHERE shop_id = ? AND status = 'confirmed' AND appointment_time >= NOW()").all(req.params.id);
  }
  const bookedIsoSet = new Set(booked.map(b => new Date(b.appointment_time).toISOString()));
  const slotsByDate = computeAvailableSlots(availabilityRows, bookedIsoSet, slotMinutes, 14);
  res.json({ slot_minutes: slotMinutes, slots_by_date: slotsByDate });
});

// Client (public) : réserver un créneau
app.post('/api/shops/:id/appointments', async (req, res) => {
  const shopId = req.params.id;
  const { customer_id, appointment_time, service_id, staff_id } = req.body;
  if (!customer_id || !appointment_time) return res.status(400).json({ success: false, error: 'Champs manquants' });
  const shop = await db.prepare('SELECT booking_enabled FROM shops WHERE id = ?').get(shopId);
  if (!shop || shop.booking_enabled !== 1) return res.status(404).json({ success: false, error: 'Rendez-vous non disponibles' });
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND shop_id = ?').get(customer_id, shopId);
  if (!customer) return res.status(404).json({ success: false, error: 'Client introuvable' });
  // Empêche un double-booking du même créneau (course entre deux clients qui réservent en même temps).
  // Avec plusieurs coiffeurs, on ne bloque que le planning DE CE coiffeur précis, pas toute la boutique.
  const clash = staff_id
    ? await db.prepare("SELECT id FROM appointments WHERE shop_id = ? AND staff_id = ? AND appointment_time = ? AND status = 'confirmed'").get(shopId, staff_id, appointment_time)
    : await db.prepare("SELECT id FROM appointments WHERE shop_id = ? AND appointment_time = ? AND status = 'confirmed'").get(shopId, appointment_time);
  if (clash) return res.status(409).json({ success: false, error: 'Ce créneau vient d\'être pris, choisissez-en un autre' });
  const result = await db.prepare("INSERT INTO appointments (shop_id, customer_id, appointment_time, status, service_id, staff_id) VALUES (?, ?, ?, 'confirmed', ?, ?) RETURNING id")
    .run(shopId, customer_id, appointment_time, service_id || null, staff_id || null);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Client (public) : annuler son propre rendez-vous
app.post('/api/appointments/:apptId/cancel', async (req, res) => {
  const { customer_id } = req.body;
  await db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ? AND customer_id = ?").run(req.params.apptId, customer_id);
  res.json({ success: true });
});

// Client (public) : voir ses propres rendez-vous à venir
app.get('/api/customers/:id/appointments', async (req, res) => {
  const rows = await db.prepare(`
    SELECT a.*, s.name as shop_name, sv.name as service_name, st.name as staff_name
    FROM appointments a
    JOIN shops s ON s.id = a.shop_id
    LEFT JOIN services sv ON sv.id = a.service_id
    LEFT JOIN staff_members st ON st.id = a.staff_id
    WHERE a.customer_id = ? AND a.status = 'confirmed' AND a.appointment_time >= NOW()
    ORDER BY a.appointment_time ASC
  `).all(req.params.id);
  res.json(rows);
});

app.get('/card/:id', async (req, res) => {
  const id = req.params.id;
  const ua = req.headers['user-agent'] || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  const cardShop = await db.prepare('SELECT s.id as shop_id, s.name as shop_name, s.logo_base64, s.booking_enabled FROM customers c JOIN shops s ON s.id = c.shop_id WHERE c.id = ?').get(id);
  const shopName = (cardShop && cardShop.shop_name) ? cardShop.shop_name : 'FidélyPass';
  const shopIcon = (cardShop && cardShop.logo_base64) ? ('/shops/' + cardShop.shop_id + '/logo-file') : '/icon-192.png';
  const manifestUrl = cardShop ? ('/manifest/' + cardShop.shop_id + '.json') : '/manifest.json';

  let bookingHtml = '';
  if (cardShop && cardShop.booking_enabled === 1) {
    bookingHtml = '<button class="notif-btn" id="booking-btn" onclick="openBookingPicker()" style="margin-top:8px;background:#eff6ff;color:#1d4ed8">📅 Prendre rendez-vous</button>';
  }

  let walletHtml = '';
  if (!isAndroid) {
    walletHtml = '<a href="/api/customers/' + id + '/apple-wallet" style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;background:#000;color:white;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none"><svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422s1.675-2.789 1.698-2.854-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758q.52-1.185.473-1.282"/></svg> Ajouter à Apple Wallet</a>';
  } else {
    walletHtml = '<div id="wallet-btn"><script>fetch("/api/customers/' + id + '/wallet").then(r=>r.json()).then(d=>{if(d.url){document.getElementById("wallet-btn").innerHTML=\'<a href="\'+d.url+\'" target="_blank"><img src="https://pay.google.com/about/static/sample-assets/pay-with-google/add-to-wallet-button.svg" style="width:200px;margin-top:8px" alt="Ajouter à Google Wallet"><\\/a>\';}});<\\/script></div>';
  }

  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Ma carte FidélyPass</title><link rel="manifest" href="${manifestUrl}"><link rel="apple-touch-icon" href="${shopIcon}"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${shopName.replace(/"/g, '&quot;')}"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#1a1a1a"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:340px}h1{font-size:22px;font-weight:800;margin-bottom:4px}p{color:#6b7280;font-size:13px;margin-bottom:24px}#qr{width:200px;height:200px;border-radius:12px}.id{margin-top:16px;font-size:13px;color:#9ca3af}.points-box{margin-top:20px;background:#f8fafc;border-radius:16px;padding:16px}.points-val{font-size:28px;font-weight:900;color:#111827}.points-goal{font-size:13px;color:#6b7280;margin-bottom:10px}.progress-track{background:#e5e7eb;border-radius:99px;height:10px;overflow:hidden}.progress-fill{background:#3b82f6;height:100%;border-radius:99px;transition:width 0.4s ease}.review-banner{margin-top:20px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px;padding:16px;color:white;text-align:center;display:none}.review-banner h3{font-size:16px;font-weight:800;margin-bottom:6px}.review-banner p{color:rgba(255,255,255,0.9);font-size:13px;margin-bottom:12px}.review-btn{display:inline-block;background:white;color:#d97706;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none}.notif-btn{margin-top:16px;background:#f3f4f6;color:#374151;border:none;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer}.notif-btn.on{background:#dcfce7;color:#16a34a}.unsub-link{display:block;margin-top:8px;font-size:11px;color:#9ca3af;text-decoration:underline;cursor:pointer;background:none;border:none}.ios-hint{margin-top:12px;background:#fef3c7;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400e;text-align:left;line-height:1.5;display:none}.section-box{margin-top:20px;background:#f8fafc;border-radius:16px;padding:16px;text-align:left}.grade-badge{display:inline-flex;align-items:center;gap:6px;background:#f3f4f6;color:#374151;font-size:12px;font-weight:800;padding:6px 14px;border-radius:99px;margin:10px 0 0}.tier-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:13px}.tier-row:last-child{border-bottom:none}.tier-check{width:22px;height:22px;border-radius:50%;background:#e5e7eb;color:#9ca3af;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}.tier-check.done{background:#059669;color:white}.tier-name{flex:1;font-weight:600;color:#374151}.tier-name.done{color:#059669}.tier-pts{font-size:11px;color:#9ca3af;flex-shrink:0}.section-title{font-size:13px;font-weight:800;color:#374151;margin-bottom:10px;text-align:center}.history-row{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;padding:6px 0;border-bottom:1px solid #e5e7eb}.history-row:last-child{border-bottom:none}.referral-link-box{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:10px;font-size:11px;color:#374151;word-break:break-all;margin-bottom:10px}.referral-copy-btn{width:100%;padding:12px;border-radius:10px;background:#3b82f6;color:white;font-size:13px;font-weight:700;border:none;cursor:pointer}.onboarding-overlay{position:fixed;inset:0;background:linear-gradient(135deg,#0f172a,#1e1b4b 50%,#0f172a);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;padding:32px;text-align:center;overflow:hidden}.onboarding-overlay::before{content:'';position:absolute;inset:-50%;background:radial-gradient(circle at 30% 30%,rgba(59,130,246,0.25),transparent 50%),radial-gradient(circle at 70% 70%,rgba(168,85,247,0.2),transparent 50%);animation:obDrift 8s ease-in-out infinite alternate}@keyframes obDrift{from{transform:translate(0,0) rotate(0deg)}to{transform:translate(3%,3%) rotate(8deg)}}.onboarding-icon{width:88px;height:88px;border-radius:50%;background:rgba(59,130,246,0.15);border:1px solid rgba(96,165,250,0.4);display:flex;align-items:center;justify-content:center;font-size:40px;margin-bottom:24px;animation:obPulse 1.8s ease-in-out infinite;position:relative;z-index:1}@keyframes obPulse{0%,100%{box-shadow:0 0 0 0 rgba(96,165,250,0.35)}50%{box-shadow:0 0 0 16px rgba(96,165,250,0)}}.onboarding-title{color:white;font-size:21px;font-weight:800;margin-bottom:10px;position:relative;z-index:1;animation:obFadeUp 0.5s ease}.onboarding-text{color:#cbd5e1;font-size:14px;line-height:1.6;max-width:280px;position:relative;z-index:1;animation:obFadeUp 0.5s ease 0.1s both}@keyframes obFadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.onboarding-dots{display:flex;gap:8px;margin-top:32px;position:relative;z-index:1}.onboarding-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,0.25);transition:all 0.3s}.onboarding-dot.active{background:#60a5fa;width:22px;border-radius:4px}.onboarding-skip{margin-top:28px;background:none;border:none;color:rgba(255,255,255,0.5);font-size:13px;text-decoration:underline;cursor:pointer;position:relative;z-index:1}.onboarding-cta{margin-top:24px;background:white;color:#1e1b4b;border:none;padding:14px 32px;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;position:relative;z-index:1;display:none}.onboarding-nav{display:flex;gap:18px;margin-top:22px;position:relative;z-index:1}.onboarding-nav-btn{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.25);color:white;width:46px;height:46px;border-radius:50%;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity 0.2s}.onboarding-nav-btn:disabled{opacity:0.2;cursor:default}.onboarding-dot{cursor:pointer}.ob-mock{margin-top:22px;position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:4px}.ob-mock-hand{font-size:26px;animation:obBounce 1s ease-in-out infinite}@keyframes obBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}.ob-mock-btn{background:#000;color:white;padding:10px 18px;border-radius:12px;font-size:13px;font-weight:700}.ob-mock-btn.light{background:#f3f4f6;color:#374151}.ob-mock-bar{background:#e5e7eb;border-radius:10px;padding:8px 16px;font-size:14px;font-weight:700;color:#374151}.ob-mock-step{color:#e2e8f0;font-size:12px;line-height:1.5;max-width:260px}.ob-safari-bar{margin:10px 0;background:#1f2937;border-radius:14px;padding:12px 18px;display:flex;gap:20px;align-items:center;font-size:17px;color:#94a3b8}.ob-safari-bar .hl{color:#60a5fa;transform:scale(1.35);animation:obPulse2 1.2s ease-in-out infinite}@keyframes obPulse2{0%,100%{transform:scale(1.35)}50%{transform:scale(1.6)}}.ob-phone{margin-top:18px;background:#ffffff;border:6px solid #1c1c1e;border-radius:34px;padding:0;width:240px;box-shadow:0 10px 30px rgba(0,0,0,0.35);position:relative;z-index:1;overflow:hidden}.ob-phone-status{display:flex;justify-content:space-between;padding:6px 14px 2px;font-size:10px;font-weight:700;color:#111827;background:#fff}.ob-phone-bar{background:#eceded;border-radius:8px;padding:6px 8px;font-size:9px;color:#374151;text-align:center;margin:4px 10px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ob-phone-content{background:#f8fafc;height:46px;display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 10px 8px;border-radius:8px;border:1px solid #eef0f2}.ob-phone-toolbar{display:flex;justify-content:space-around;align-items:center;background:#f7f7f8;border-top:1px solid #e5e7eb;padding:12px 8px}.ob-share-icon{position:relative;display:flex}.ob-share-icon svg{animation:obPulse2 1.2s ease-in-out infinite}@keyframes obPulse2{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}.ob-callout{position:absolute;top:-30px;left:50%;transform:translateX(-50%);font-size:20px;animation:obBounce 1s ease-in-out infinite}.ob-sheet{background:#fff;border-top:1px solid #e5e7eb}.ob-sheet-handle{width:36px;height:4px;background:#d1d5db;border-radius:99px;margin:8px auto}.ob-sheet-row{display:flex;align-items:center;gap:10px;padding:11px 16px;font-size:13px;color:#111827;border-bottom:1px solid #f1f1f1;font-weight:500}.ob-sheet-row:last-child{border-bottom:none}.ob-sheet-row.hl{background:#eff6ff;color:#1d4ed8;font-weight:700}.booking-picker-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:none;align-items:flex-end;justify-content:center;z-index:9998}.booking-picker-card{background:white;border-radius:20px 20px 0 0;padding:20px;width:100%;max-width:400px;max-height:75vh;overflow-y:auto}.booking-picker-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.booking-picker-close{background:#f3f4f6;border:none;width:30px;height:30px;border-radius:50%;font-size:15px;cursor:pointer;color:#374151}.booking-dates-scroll{display:flex;overflow-x:auto;margin-bottom:16px;padding-bottom:4px;gap:8px}.booking-date-pill{flex-shrink:0;padding:8px 14px;border-radius:99px;background:#f3f4f6;color:#374151;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}.booking-date-pill.active{background:#3b82f6;color:white}.booking-slots-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.booking-slot-btn{padding:10px 4px;border-radius:10px;background:#f8fafc;border:1px solid #e5e7eb;font-size:13px;font-weight:700;cursor:pointer;color:#111827}.booking-slot-btn:hover{background:#eff6ff;border-color:#3b82f6}.appt-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #e5e7eb;font-size:12.5px;gap:8px}.appt-row:last-child{border-bottom:none}.appt-cancel-btn{flex-shrink:0;background:#fee2e2;color:#dc2626;border:none;padding:5px 10px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer}.primary-actions{display:flex;flex-direction:column;gap:10px;margin-top:18px}.accordion{margin-top:12px;background:#f8fafc;border-radius:16px;overflow:hidden;text-align:left}.accordion-header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;font-size:13px;font-weight:800;color:#374151;user-select:none}.accordion-chevron{font-size:11px;color:#9ca3af;transition:transform 0.25s ease}.accordion.open .accordion-chevron{transform:rotate(180deg)}.accordion-body{max-height:0;overflow:hidden;transition:max-height 0.3s ease}.accordion.open .accordion-body{max-height:700px}.accordion-body-inner{padding:0 16px 16px}.settings-links{margin-top:18px;display:flex;flex-direction:column;gap:6px;align-items:center}</style></head><body><div class="onboarding-overlay" id="onboarding-overlay"><div class="onboarding-icon" id="ob-icon">📲</div><div class="onboarding-title" id="ob-title">Bienvenue !</div><div class="onboarding-text" id="ob-text">Voici comment profiter de votre carte de fidélité.</div><div id="ob-mockup"></div><div class="onboarding-dots" id="ob-dots"></div><div class="onboarding-nav"><button class="onboarding-nav-btn" id="ob-prev" onclick="goObStep(-1)">‹</button><button class="onboarding-nav-btn" id="ob-next" onclick="goObStep(1)">›</button></div><button class="onboarding-cta" id="ob-cta" onclick="dismissOnboarding()">C'est parti 🚀</button><button class="onboarding-skip" onclick="dismissOnboarding()">Passer</button></div><div class="card"><h1>🎯 FidélyPass</h1><p>Présentez ce QR code au gérant</p><img id="qr" src="" alt="QR Code"><div class="id">Carte n°${id}</div><div class="grade-badge" id="grade-badge" style="display:none"></div><div class="points-box" id="points-box" style="display:none"><div class="points-val" id="points-val">0</div><div class="points-goal" id="points-goal-text">sur 0 points</div><div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div></div><div class="primary-actions">${walletHtml}${bookingHtml}<button class="notif-btn" id="notif-btn" onclick="enableNotifs()">🔔 Activer les notifications</button></div><div class="ios-hint" id="ios-hint">📲 Sur iPhone : pour recevoir les notifications, ajoutez d'abord cette page à votre écran d'accueil (bouton partager <strong>⬆️</strong> puis "Sur l'écran d'accueil"), ouvrez l'app depuis l'icône, puis réessayez.</div><div class="review-banner" id="review-banner"><h3>🎉 Objectif atteint !</h3><p id="review-banner-text">Votre avis compte beaucoup pour nous</p><a id="review-link" class="review-btn" href="#" target="_blank" style="display:none">⭐ Laisser un avis Google</a></div><div class="accordion" id="tiers-box" style="display:none"><div class="accordion-header" onclick="toggleAccordion('tiers-box')"><span>🎯 Paliers de récompense</span><span class="accordion-chevron">▾</span></div><div class="accordion-body"><div class="accordion-body-inner"><div id="tiers-list"></div></div></div></div><div class="accordion" id="booking-upcoming-box" style="display:none"><div class="accordion-header" onclick="toggleAccordion('booking-upcoming-box')"><span>📅 Mes rendez-vous</span><span class="accordion-chevron">▾</span></div><div class="accordion-body"><div class="accordion-body-inner"><div id="my-appointments-list"></div></div></div></div><div class="accordion" id="info-box" style="display:none"><div class="accordion-header" onclick="toggleAccordion('info-box')"><span>ℹ️ Infos pratiques</span><span class="accordion-chevron">▾</span></div><div class="accordion-body"><div class="accordion-body-inner" style="display:flex;flex-direction:column;gap:10px"><a id="menu-link" href="#" target="_blank" style="display:none;align-items:center;justify-content:center;gap:8px;background:#eef2f6;color:#374151;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none">📋 Voir le menu</a><a id="phone-link" href="#" style="display:none;align-items:center;justify-content:center;gap:8px;background:#eef2f6;color:#374151;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none">📞 Appeler la boutique</a><div id="hours-text" style="display:none;font-size:13px;color:#6b7280;text-align:center">🕒 <span id="hours-value"></span></div></div></div></div><div class="accordion" id="referral-box" style="display:none"><div class="accordion-header" onclick="toggleAccordion('referral-box')"><span>🎁 Parrainez un ami</span><span class="accordion-chevron">▾</span></div><div class="accordion-body"><div class="accordion-body-inner"><p style="font-size:12px;color:#6b7280;margin-bottom:10px;text-align:center">Votre ami reçoit des points, vous aussi !</p><div class="referral-link-box" id="referral-link-text"></div><button class="referral-copy-btn" onclick="copyReferralLink()">📋 Copier mon lien de parrainage</button></div></div></div><div class="accordion" id="history-box" style="display:none"><div class="accordion-header" onclick="toggleAccordion('history-box')"><span>📋 Historique des visites</span><span class="accordion-chevron">▾</span></div><div class="accordion-body"><div class="accordion-body-inner"><div id="history-list"></div></div></div></div><div class="settings-links"><button class="unsub-link" id="unsub-link" onclick="disableNotifs()" style="display:none">Se désabonner des notifications</button><button class="unsub-link" onclick="showOnboardingOverlay()" style="display:block">🔄 Revoir le tuto</button></div></div><div class="booking-picker-overlay" id="booking-picker-overlay"><div class="booking-picker-card"><div class="booking-picker-header"><div class="section-title" style="margin:0">Choisissez un créneau</div><button class="booking-picker-close" onclick="closeBookingPicker()">✕</button></div><div id="booking-dates-row"></div><div id="booking-slots-grid" class="booking-slots-grid"></div></div></div><script>
const IS_IOS = ${isIOS};

let OB_STEPS = [
  {icon:'📲', title:'Bienvenue !', text:"On vous montre tout ce qu'il faut faire, une bonne fois pour toutes."},
  {icon:'💳', title:'Ajoutez votre carte', text:"Appuyez sur le bouton Wallet ci-dessous pour l'ajouter à Apple Wallet ou Google Wallet.", mock:'<div class="ob-mock"><div class="ob-mock-hand">👆</div><div class="ob-mock-btn"><svg width="13" height="13" viewBox="0 0 16 16" fill="white" style="vertical-align:-2px;margin-right:4px"><path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18c-1.066 1.156-.902 2.482-.878 2.516s1.52.087 2.475-1.258.762-2.391.728-2.43m3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422s1.675-2.789 1.698-2.854-.597-.79-1.254-1.157a3.7 3.7 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56s.625 1.924 1.273 2.796c.576.984 1.34 1.667 1.659 1.899s1.219.386 1.843.067c.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758q.52-1.185.473-1.282"/></svg>Ajouter à Apple Wallet</div></div>'},
  {icon:'🔖', title:'Ajoutez cette page à l\\'écran d\\'accueil', text:"Appuyez sur Partager ⬆️ en bas de l'écran, faites défiler la liste qui s'ouvre, et touchez l'option entourée tout en bas.", mock:'<img src="/onboarding-home-screen.png" alt="Ou trouver l\\'option Sur l\\'ecran d\\'accueil" style="width:100%;max-width:290px;border-radius:14px;border:1px solid rgba(255,255,255,0.15);box-shadow:0 8px 24px rgba(0,0,0,0.35);margin-top:16px">', iosOnly:true},
  {icon:'ℹ️', title:'Au dos de votre carte', text:"Ouvrez l'app Wallet, appuyez sur votre carte FidélyPass, puis sur « Informations sur la carte » (le petit ⓘ) pour retrouver notre numéro de téléphone, le menu et nos horaires à tout moment.", mock:'<div class="ob-mock"><div class="ob-mock-hand">👆</div><div class="ob-mock-btn light" style="border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;padding:0;font-size:20px">ⓘ</div></div>'},
  {icon:'🔔', title:'Activez les notifications', text:"Appuyez sur le bouton 🔔 plus bas pour être prévenu de vos offres et de votre récompense.", mock:'<div class="ob-mock"><div class="ob-mock-hand">👆</div><div class="ob-mock-btn light">🔔 Activer les notifications</div></div>'},
  {icon:'🤝', title:'Parrainez vos amis', text:"Plus bas, copiez votre lien de parrainage et partagez-le : votre ami reçoit des points, vous aussi !", mock:'<div class="ob-mock"><div class="ob-mock-hand">👆</div><div class="ob-mock-btn light">📋 Copier mon lien de parrainage</div></div>'},
  {icon:'⭐', title:'Montrez votre carte à chaque achat', text:"Présentez-la au comptoir à chaque passage pour cumuler des points automatiquement."},
  {icon:'🎁', title:'Vous êtes prêt !', text:"Une fois l'objectif atteint, votre récompense vous attend !"}
];
if (!IS_IOS) { OB_STEPS = OB_STEPS.filter(s => !s.iosOnly); }
let obIndex = 0;

function renderOnboardingDots() {
  const dots = document.getElementById('ob-dots');
  if (!dots) return;
  dots.innerHTML = OB_STEPS.map((_, i) => '<div class="onboarding-dot' + (i === obIndex ? ' active' : '') + '" onclick="jumpObStep(' + i + ')"></div>').join('');
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
  document.getElementById('ob-mockup').innerHTML = step.mock || '';
  titleEl.style.animation = 'none'; textEl.style.animation = 'none';
  void titleEl.offsetWidth; void textEl.offsetWidth;
  titleEl.style.animation = ''; textEl.style.animation = '';
  renderOnboardingDots();
  const isLast = (i === OB_STEPS.length - 1);
  document.getElementById('ob-cta').style.display = isLast ? 'inline-block' : 'none';
  document.getElementById('ob-prev').disabled = (i === 0);
  document.getElementById('ob-next').style.visibility = isLast ? 'hidden' : 'visible';
}

function goObStep(delta) {
  const next = Math.max(0, Math.min(OB_STEPS.length - 1, obIndex + delta));
  showObStep(next);
}

function jumpObStep(i) {
  showObStep(i);
}

function dismissOnboarding() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  overlay.style.transition = 'opacity 0.4s ease';
  overlay.style.opacity = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 400);
  try { localStorage.setItem('fp_onboarded_${id}', '1'); } catch (e) {}
}

function showOnboardingOverlay() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.style.transition = 'opacity 0.4s ease';
  overlay.style.opacity = '1';
  showObStep(0);
}

function startOnboarding() {
  let alreadySeen = false;
  try { alreadySeen = localStorage.getItem('fp_onboarded_${id}') === '1'; } catch (e) {}
  if (alreadySeen) {
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) overlay.style.display = 'none';
    return;
  }
  showOnboardingOverlay();
}
startOnboarding();
const IS_STANDALONE = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

fetch("/api/customers/${id}/qr").then(r=>r.json()).then(d=>document.getElementById("qr").src=d.qr);

fetch("/api/customers/${id}").then(r=>r.json()).then(c => {
  if (c.error) return;

  const GRADES = [
    { name: 'Bronze', emoji: '🥉' }, { name: 'Argent', emoji: '🥈' }, { name: 'Or', emoji: '🥇' },
    { name: 'Platine', emoji: '🔷' }, { name: 'Diamant', emoji: '💎' }, { name: 'Élite', emoji: '⭐' },
    { name: 'Famille', emoji: '👑' }
  ];
  const gradeIdx = Math.min(c.reward_cycles_completed || 0, GRADES.length - 1);
  const grade = GRADES[gradeIdx];
  const gradeBadge = document.getElementById('grade-badge');
  gradeBadge.textContent = grade.emoji + ' ' + grade.name;
  gradeBadge.style.display = 'inline-flex';

  const tiers = c.reward_tiers || [];

  if (tiers.length > 0) {
    const box = document.getElementById('points-box');
    box.style.display = 'block';
    document.getElementById('points-val').textContent = c.points + ' pts';
    const nextTier = tiers.find(t => c.points < t.threshold_points);
    document.getElementById('points-goal-text').textContent = nextTier ? ('sur ' + nextTier.threshold_points + ' points') : 'Tous les paliers débloqués !';
    const topThreshold = tiers[tiers.length - 1].threshold_points;
    const pct = Math.min(100, Math.round((c.points / topThreshold) * 100));
    document.getElementById('progress-fill').style.width = pct + '%';

    const tiersBox = document.getElementById('tiers-box');
    const tiersList = document.getElementById('tiers-list');
    tiersList.innerHTML = tiers.map(t => {
      const done = c.points >= t.threshold_points;
      return '<div class="tier-row"><div class="tier-check' + (done ? ' done' : '') + '">' + (done ? '✓' : '') + '</div><div class="tier-name' + (done ? ' done' : '') + '">' + t.reward_text + '</div><div class="tier-pts">' + t.threshold_points + ' pts</div></div>';
    }).join('');
    tiersBox.style.display = 'block';

    if (tiers.some(t => c.points >= t.threshold_points)) {
      const unlockedTiers = tiers.filter(t => c.points >= t.threshold_points);
      const lastUnlocked = unlockedTiers[unlockedTiers.length - 1];
      const banner = document.getElementById('review-banner');
      const link = document.getElementById('review-link');
      document.getElementById('review-banner-text').textContent = 'Récompense disponible : ' + lastUnlocked.reward_text + ' — montrez cet écran au gérant !';
      if (c.google_review_url) { link.href = c.google_review_url; link.style.display = 'inline-block'; }
      banner.style.display = 'block';
    }
  } else {
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
  }

  if (c.menu_url) {
    const menuLink = document.getElementById('menu-link');
    menuLink.href = c.menu_url;
    menuLink.style.display = 'flex';
    document.getElementById('info-box').style.display = 'block';
  }

  if (c.phone) {
    const phoneLink = document.getElementById('phone-link');
    phoneLink.href = 'tel:' + c.phone.replace(/\\s/g, '');
    phoneLink.style.display = 'flex';
    document.getElementById('info-box').style.display = 'block';
  }

  if (c.opening_hours) {
    document.getElementById('hours-value').textContent = c.opening_hours;
    document.getElementById('hours-text').style.display = 'block';
    document.getElementById('info-box').style.display = 'block';
  }

  if (c.slug) {
    window.__referralLink = window.location.origin + '/join/' + c.slug + '?ref=' + c.id;
    document.getElementById('referral-link-text').textContent = window.__referralLink;
    document.getElementById('referral-box').style.display = 'block';
  }
});

fetch("/api/customers/${id}/history").then(r=>r.json()).then(rows => {
  document.getElementById('history-box').style.display = 'block';
  if (!rows || !rows.length) {
    document.getElementById('history-list').innerHTML = '<div style="font-size:13px;color:#9ca3af;text-align:center;padding:8px 0">Aucune visite pour l\\'instant</div>';
    return;
  }
  document.getElementById('history-list').innerHTML = rows.map(r => {
    const d = new Date(r.scanned_at);
    const dateStr = d.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'2-digit'});
    const label = r.is_manual === 1 ? dateStr + ' · ajustement manuel' : dateStr;
    return '<div class="history-row"><span>' + label + '</span><span>+' + r.points_added + ' pts</span></div>';
  }).join('');
});

function toggleAccordion(id) {
  document.getElementById(id).classList.toggle('open');
}

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

/* ---------- Prise de rendez-vous ---------- */
const BOOKING_SHOP_ID = ${cardShop ? cardShop.shop_id : 'null'};
const BOOKING_CUSTOMER_ID = ${id};
let bookingSlotsData = null;
let bookingSelectedDate = null;
let bookingSelectedServiceId = null;
let bookingServicesList = [];
let bookingSelectedStaffId = null;
let bookingStaffList = [];

async function openBookingPicker() {
  document.getElementById('booking-picker-overlay').style.display = 'flex';
  bookingSelectedServiceId = null;
  bookingSelectedStaffId = null;
  const res = await fetch('/api/shops/' + BOOKING_SHOP_ID + '/services-public');
  bookingServicesList = await res.json();
  if (bookingServicesList.length > 0) {
    showServiceStep();
  } else {
    await goToStaffOrSlotStep();
  }
}

function showServiceStep() {
  document.getElementById('booking-dates-row').innerHTML = '';
  document.getElementById('booking-slots-grid').innerHTML = bookingServicesList.map(s =>
    '<button class="booking-slot-btn" style="grid-column:1/-1;text-align:left;display:flex;justify-content:space-between;align-items:center" onclick="chooseService(' + s.id + ')"><span>' + s.name + ' · ' + s.duration_minutes + ' min</span>' + (s.price ? '<span style="color:#3b82f6">' + s.price + '€</span>' : '') + '</button>'
  ).join('');
}

async function chooseService(serviceId) {
  bookingSelectedServiceId = serviceId;
  await goToStaffOrSlotStep();
}

async function goToStaffOrSlotStep() {
  const res = await fetch('/api/shops/' + BOOKING_SHOP_ID + '/staff-public');
  bookingStaffList = await res.json();
  if (bookingStaffList.length > 0) {
    showStaffStep();
  } else {
    await showSlotStep();
  }
}

function showStaffStep() {
  document.getElementById('booking-dates-row').innerHTML = '';
  document.getElementById('booking-slots-grid').innerHTML = bookingStaffList.map(s =>
    '<button class="booking-slot-btn" style="grid-column:1/-1;text-align:left" onclick="chooseStaff(' + s.id + ')">👤 ' + s.name + '</button>'
  ).join('');
}

async function chooseStaff(staffId) {
  bookingSelectedStaffId = staffId;
  await showSlotStep();
}

async function showSlotStep() {
  document.getElementById('booking-dates-row').innerHTML = '<div style="font-size:13px;color:#9ca3af;padding:20px 0">Chargement…</div>';
  document.getElementById('booking-slots-grid').innerHTML = '';
  const params = [];
  if (bookingSelectedServiceId) params.push('service_id=' + bookingSelectedServiceId);
  if (bookingSelectedStaffId) params.push('staff_id=' + bookingSelectedStaffId);
  const url = '/api/shops/' + BOOKING_SHOP_ID + '/available-slots' + (params.length ? '?' + params.join('&') : '');
  const res = await fetch(url);
  bookingSlotsData = await res.json();
  const dates = Object.keys(bookingSlotsData.slots_by_date || {});
  bookingSelectedDate = dates[0] || null;
  renderBookingDates(dates);
  renderBookingSlots();
}

function closeBookingPicker() {
  document.getElementById('booking-picker-overlay').style.display = 'none';
}

function renderBookingDates(dates) {
  const el = document.getElementById('booking-dates-row');
  if (!dates.length) {
    el.className = '';
    el.innerHTML = '<div style="font-size:13px;color:#9ca3af;padding:10px 0;text-align:center">Aucun créneau disponible pour le moment</div>';
    return;
  }
  el.className = 'booking-dates-scroll';
  el.innerHTML = dates.map(d => {
    const dt = new Date(d + 'T12:00:00');
    const label = dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    return '<div class="booking-date-pill' + (d === bookingSelectedDate ? ' active' : '') + '" onclick="selectBookingDate(\\'' + d + '\\')">' + label + '</div>';
  }).join('');
}

function selectBookingDate(d) {
  bookingSelectedDate = d;
  renderBookingDates(Object.keys(bookingSlotsData.slots_by_date));
  renderBookingSlots();
}

function renderBookingSlots() {
  const el = document.getElementById('booking-slots-grid');
  if (!bookingSelectedDate) { el.innerHTML = ''; return; }
  const slots = (bookingSlotsData.slots_by_date[bookingSelectedDate] || []);
  el.innerHTML = slots.map(iso => {
    const t = new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return '<button class="booking-slot-btn" onclick="bookSlot(\\'' + iso + '\\')">' + t + '</button>';
  }).join('');
}

async function bookSlot(iso) {
  const res = await fetch('/api/shops/' + BOOKING_SHOP_ID + '/appointments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: BOOKING_CUSTOMER_ID, appointment_time: iso, service_id: bookingSelectedServiceId, staff_id: bookingSelectedStaffId })
  });
  const data = await res.json();
  if (data.success) {
    closeBookingPicker();
    alert('✅ Rendez-vous confirmé !');
    loadMyAppointments();
  } else {
    alert('❌ ' + (data.error || "Ce créneau n'est plus disponible"));
    showSlotStep();
  }
}

async function loadMyAppointments() {
  if (!BOOKING_SHOP_ID) return;
  const res = await fetch('/api/customers/' + BOOKING_CUSTOMER_ID + '/appointments');
  const rows = await res.json();
  const box = document.getElementById('booking-upcoming-box');
  const list = document.getElementById('my-appointments-list');
  if (!rows.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  list.innerHTML = rows.map(r => {
    const d = new Date(r.appointment_time);
    const label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const serviceLabel = r.service_name ? ' — ' + r.service_name : '';
    const staffLabel = r.staff_name ? ' avec ' + r.staff_name : '';
    const subLabel = (serviceLabel || staffLabel) ? '<br><span style="color:#9ca3af;font-size:11.5px">' + r.service_name + staffLabel + '</span>' : '';
    return '<div class="appt-row"><span>' + label + subLabel + '</span><button class="appt-cancel-btn" onclick="cancelMyAppointment(' + r.id + ')">Annuler</button></div>';
  }).join('');
}

async function cancelMyAppointment(apptId) {
  if (!confirm('Annuler ce rendez-vous ?')) return;
  await fetch('/api/appointments/' + apptId + '/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: BOOKING_CUSTOMER_ID })
  });
  loadMyAppointments();
}

if (BOOKING_SHOP_ID) { loadMyAppointments(); }

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
  const { name, slug, password, reward_text, points_per_euro, points_goal, color, google_review_url, email, referral_bonus_points, currency, menu_url, latitude, longitude, logo_base64, menu_file_base64, phone, opening_hours, manual_shop_count, risk_threshold_days, lost_threshold_days, booking_enabled } = req.body;
  try {
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
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
    await db.prepare(`UPDATE shops SET name=?, slug=?, password=?, reward_text=?, points_per_euro=?, points_goal=?, color=?, google_review_url=?, email=?, referral_bonus_points=?, currency=?, menu_url=?, latitude=?, longitude=?, logo_base64=?, menu_file_base64=?, menu_file_type=?, phone=?, opening_hours=?, manual_shop_count=?, risk_threshold_days=?, lost_threshold_days=?, booking_enabled=? WHERE id=?`)
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
        manual_shop_count !== undefined && manual_shop_count !== '' ? (manual_shop_count != null ? parseInt(manual_shop_count, 10) : null) : shop.manual_shop_count,
        risk_threshold_days !== undefined && risk_threshold_days !== '' ? parseInt(risk_threshold_days, 10) : (shop.risk_threshold_days || 30),
        lost_threshold_days !== undefined && lost_threshold_days !== '' ? parseInt(lost_threshold_days, 10) : (shop.lost_threshold_days || 60),
        booking_enabled !== undefined ? (booking_enabled ? 1 : 0) : (shop.booking_enabled || 0),
        req.params.id
      );
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.delete('/api/shops/:id', async (req, res) => {
  try {
    const customerIds = (await db.prepare('SELECT id FROM customers WHERE shop_id = ?').all(req.params.id)).map(c => c.id);
    if (customerIds.length) {
      const placeholders = customerIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM push_subscriptions WHERE customer_id IN (${placeholders})`).run(...customerIds);
      const serials = customerIds.map(id => 'fidelypass-' + id);
      const serialPlaceholders = serials.map(() => '?').join(',');
      await db.prepare(`DELETE FROM apple_pass_registrations WHERE serial_number IN (${serialPlaceholders})`).run(...serials);
    }
    await db.prepare('DELETE FROM sessions_store WHERE shop_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM scans WHERE shop_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM customers WHERE shop_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// Sert le logo de la boutique en tant que vraie image accessible publiquement (nécessaire pour
// Google Wallet, qui exige une URL et n'accepte pas une image encodée en base64 directement)
app.get('/shops/:id/logo-file', async (req, res) => {
  const shop = await db.prepare('SELECT logo_base64 FROM shops WHERE id = ?').get(req.params.id);
  if (!shop || !shop.logo_base64) return res.status(404).send('Aucun logo disponible');
  const match = String(shop.logo_base64).match(/^data:([^;]+);base64,(.+)$/);
  const mime = match ? match[1] : 'image/png';
  const raw = match ? match[2] : shop.logo_base64;
  res.set('Content-Type', mime);
  res.send(Buffer.from(raw, 'base64'));
});

// Manifest web app dynamique par boutique — utilise le vrai logo/nom du commerçant
// pour que l'icône ajoutée à l'écran d'accueil et les notifications iOS affichent
// le logo du client au lieu de l'icône générique FidélyPass
app.get('/manifest/:shopId.json', async (req, res) => {
  const shop = await db.prepare('SELECT name, logo_base64 FROM shops WHERE id = ?').get(req.params.shopId);
  const name = (shop && shop.name) ? shop.name : 'FidélyPass';
  const hasLogo = !!(shop && shop.logo_base64);
  const iconSrc = hasLogo ? ('/shops/' + req.params.shopId + '/logo-file') : '/icon-192.png';
  res.set('Content-Type', 'application/manifest+json');
  res.json({
    name: name,
    short_name: name,
    display: 'standalone',
    background_color: '#f2f2f7',
    theme_color: '#1a1a1a',
    icons: [{ src: iconSrc, sizes: '192x192', type: 'image/png' }]
  });
});

// Sert le fichier menu (image ou PDF) uploadé par la boutique, affiché inline dans le navigateur
app.get('/shops/:id/menu-file', async (req, res) => {
  const shop = await db.prepare('SELECT menu_file_base64, menu_file_type FROM shops WHERE id = ?').get(req.params.id);
  if (!shop || !shop.menu_file_base64) return res.status(404).send('Aucun menu disponible');
  const buffer = Buffer.from(shop.menu_file_base64, 'base64');
  res.set('Content-Type', shop.menu_file_type || 'application/octet-stream');
  res.set('Content-Disposition', 'inline; filename="menu"');
  res.send(buffer);
});

app.get('/join/:slug', async (req, res) => {
  const shop = await db.prepare('SELECT * FROM shops WHERE slug = ?').get(req.params.slug);
  if (!shop) return res.status(404).send('Boutique introuvable');
  const id = shop.id;
  const name = shop.name;
  const color = shop.color;
  const goal = shop.points_goal;
  const reward = shop.reward_text;
  const initials = shop.name.slice(0,2).toUpperCase();
  res.send('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Rejoindre ' + name + '</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f2f2f7;font-family:-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:white;border-radius:24px;padding:32px 24px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.10);width:100%;max-width:380px}.logo{width:64px;height:64px;border-radius:16px;background:' + color + ';display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;color:white;margin:0 auto 16px}h1{font-size:22px;font-weight:800;color:#1a1a1a;margin-bottom:4px}p{color:#6b7280;font-size:14px;margin-bottom:24px}.info{background:#f8fafc;border-radius:12px;padding:14px;margin-bottom:24px;font-size:13px;color:#374151}.ref-info{background:#dcfce7;border-radius:12px;padding:14px;margin-bottom:16px;font-size:13px;color:#16a34a;font-weight:600;display:none}.row{display:flex;gap:10px;margin-bottom:12px}input{width:100%;padding:16px;border:2px solid #e5e7eb;border-radius:14px;font-size:18px;text-align:center;font-weight:700;color:#1a1a1a;outline:none}input:focus{border-color:#3b82f6}button{width:100%;padding:16px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;font-size:17px;font-weight:700;border:none;cursor:pointer}.error{color:#ef4444;font-size:13px;margin-bottom:12px;display:none}</style></head><body><div class="card"><div class="logo">' + initials + '</div><h1>' + name + '</h1><p>Créez votre carte de fidélité gratuite</p><div class="ref-info" id="ref-info">🎁 Vous avez été invité(e) — points bonus à l\'inscription !</div><div class="info">🎁 Objectif : <strong>' + goal + ' points</strong><br>Récompense : <strong>' + reward + '</strong></div><div class="error" id="e">Veuillez entrer votre prénom et votre nom</div><div class="row"><input type="text" id="fn" placeholder="Prénom"><input type="text" id="ln" placeholder="Nom"></div><button onclick="j()">Obtenir ma carte 🎯</button></div><script>const ref=new URLSearchParams(window.location.search).get("ref");if(ref)document.getElementById("ref-info").style.display="block";async function j(){const fn=document.getElementById("fn").value.trim();const ln=document.getElementById("ln").value.trim();if(!fn||!ln){document.getElementById("e").style.display="block";return;}const n=fn+" "+ln;const r=await fetch("/api/customers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shop_id:' + id + ',name:n,ref:ref})});const d=await r.json();if(d.success)window.location.href="/card/"+d.id;}document.getElementById("ln").addEventListener("keypress",e=>{if(e.key==="Enter")j();});<\/script></body></html>');
});

app.get('/', (req, res) => {
  res.redirect('/landing.html');
});

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Protection anti brute-force sur l'accès admin (par IP)
const adminFailedAttempts = {};
const ADMIN_MAX_ATTEMPTS = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Nettoyage périodique pour éviter une fuite mémoire sur le tracker d'IP
setInterval(() => {
  const now = Date.now();
  for (const ip in adminFailedAttempts) {
    if (now - adminFailedAttempts[ip].firstFailAt > ADMIN_WINDOW_MS) delete adminFailedAttempts[ip];
  }
}, 60 * 60 * 1000);

function requireAdmin(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = adminFailedAttempts[ip];

  if (entry && entry.count >= ADMIN_MAX_ATTEMPTS && (now - entry.firstFailAt) < ADMIN_WINDOW_MS) {
    res.set('WWW-Authenticate', 'Basic realm="FidelyPass Admin"');
    return res.status(429).send('Trop de tentatives. Réessayez dans quelques minutes.');
  }

  const auth = req.headers['authorization'];
  const valid = auth === 'Basic ' + Buffer.from('admin:' + ADMIN_PASSWORD).toString('base64');

  if (!valid) {
    if (!entry || (now - entry.firstFailAt) > ADMIN_WINDOW_MS) {
      adminFailedAttempts[ip] = { count: 1, firstFailAt: now };
    } else {
      entry.count++;
    }
    res.set('WWW-Authenticate', 'Basic realm="FidelyPass Admin"');
    return res.status(401).send('Acces refuse');
  }

  delete adminFailedAttempts[ip];
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
    await db.prepare('INSERT INTO leads (business_name, phone) VALUES (?, ?)')
      .run(business_name.trim(), phone.trim());
    res.json({ success: true });

    // Notifie l'admin par push (ne bloque pas la réponse au client)
    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const admins = await db.prepare('SELECT * FROM admin_subscriptions').all();
      const payload = JSON.stringify({
        title: '📩 Nouvelle demande FidélyPass',
        body: business_name.trim() + ' souhaite être contacté'
      });
      for (const sub of admins) {
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        ).catch(async err => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await db.prepare('DELETE FROM admin_subscriptions WHERE id = ?').run(sub.id);
          }
        });
      }
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  const leads = await db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json(leads);
});

app.put('/api/admin/leads/:id/seen', requireAdmin, async (req, res) => {
  await db.prepare('UPDATE leads SET seen = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/leads/:id', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// NOTIFICATIONS PUSH POUR L'ADMIN
// ─────────────────────────────────────────────

app.post('/api/admin/subscribe', requireAdmin, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ success: false, error: 'Abonnement invalide' });
  }
  try {
    await db.prepare('DELETE FROM admin_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
    await db.prepare('INSERT INTO admin_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)')
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/unsubscribe', requireAdmin, async (req, res) => {
  const { endpoint } = req.body;
  try {
    if (endpoint) await db.prepare('DELETE FROM admin_subscriptions WHERE endpoint = ?').run(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/shops/:id/toggle-exempt', requireAdmin, async (req, res) => {
  try {
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    const newExempt = shop.payment_exempt === 1 ? 0 : 1;
    // Quand on exempte une boutique, on la réactive aussi immédiatement
    if (newExempt === 1) {
      await db.prepare('UPDATE shops SET payment_exempt = 1, active = 1 WHERE id = ?').run(shop.id);
    } else {
      await db.prepare('UPDATE shops SET payment_exempt = 0 WHERE id = ?').run(shop.id);
    }
    res.json({ success: true, payment_exempt: newExempt });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/admin/shops/:id/toggle-setup-fee', requireAdmin, async (req, res) => {
  try {
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });
    const newWaive = shop.waive_setup_fee === 1 ? 0 : 1;
    await db.prepare('UPDATE shops SET waive_setup_fee = ? WHERE id = ?').run(newWaive, shop.id);
    res.json({ success: true, waive_setup_fee: newWaive });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.get('/api/admin/shops/:id/stats', requireAdmin, async (req, res) => {
  const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  const customers = await db.prepare('SELECT COUNT(*) as count FROM customers WHERE shop_id = ?').get(req.params.id);
  const scans = await db.prepare('SELECT COUNT(*) as count FROM scans WHERE shop_id = ?').get(req.params.id);
  const rewards = await db.prepare("SELECT COUNT(*) as count FROM scans WHERE shop_id = ? AND points_added = 0").get(req.params.id);
  res.json({ shop, total_customers: Number(customers.count), total_scans: Number(scans.count), total_rewards: Number(rewards.count) });
});

// ─────────────────────────────────────────────
// MESSAGERIE ADMIN → GÉRANTS
// ─────────────────────────────────────────────

// Envoyer un message à tous les gérants (target_shop_id null) ou à une boutique précise
app.post('/api/admin/messages', requireAdmin, async (req, res) => {
  const { title, body, target_shop_id } = req.body;
  if (!title || !body) return res.status(400).json({ success: false, error: 'Titre et message requis' });
  const result = await db.prepare('INSERT INTO admin_messages (title, body, target_shop_id) VALUES (?, ?, ?) RETURNING id')
    .run(title, body, target_shop_id || null);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Historique des messages envoyés (avec le nom de la boutique ciblée si applicable)
app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  const messages = await db.prepare(`
    SELECT m.*, s.name as shop_name
    FROM admin_messages m LEFT JOIN shops s ON s.id = m.target_shop_id
    WHERE m.source = 'admin'
    ORDER BY m.created_at DESC LIMIT 100
  `).all();
  res.json(messages);
});

app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  await db.prepare('DELETE FROM admin_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Boîte de réception côté gérant : messages diffusés à tous + ceux ciblés sur sa boutique
app.get('/api/shops/:id/messages', requireShopAuth, async (req, res) => {
  const shopId = req.params.id;
  const shop = await db.prepare('SELECT last_message_read_at FROM shops WHERE id = ?').get(shopId);
  const messages = await db.prepare(`
    SELECT id, title, body, created_at FROM admin_messages
    WHERE target_shop_id IS NULL OR target_shop_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(shopId);
  const lastRead = shop && shop.last_message_read_at ? new Date(shop.last_message_read_at).getTime() : 0;
  const unreadCount = messages.filter(m => new Date(m.created_at).getTime() > lastRead).length;
  res.json({ messages, unread_count: unreadCount });
});

app.post('/api/shops/:id/messages/read', requireShopAuth, async (req, res) => {
  await db.prepare('UPDATE shops SET last_message_read_at = NOW() WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// PALIERS DE RÉCOMPENSE (multi-tiers configurables par le gérant)
// ─────────────────────────────────────────────

app.get('/api/shops/:id/reward-tiers', async (req, res) => {
  const tiers = await db.prepare('SELECT * FROM reward_tiers WHERE shop_id = ? ORDER BY threshold_points ASC').all(req.params.id);
  res.json(tiers);
});

app.post('/api/shops/:id/reward-tiers', requireShopAuth, async (req, res) => {
  const { threshold_points, reward_text } = req.body;
  if (!threshold_points || !reward_text) return res.status(400).json({ success: false, error: 'Seuil et récompense requis' });
  const result = await db.prepare('INSERT INTO reward_tiers (shop_id, threshold_points, reward_text) VALUES (?, ?, ?) RETURNING id')
    .run(req.params.id, parseInt(threshold_points, 10), reward_text);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/shops/:id/reward-tiers/:tierId', requireShopAuth, async (req, res) => {
  const { threshold_points, reward_text } = req.body;
  await db.prepare('UPDATE reward_tiers SET threshold_points = ?, reward_text = ? WHERE id = ? AND shop_id = ?')
    .run(parseInt(threshold_points, 10), reward_text, req.params.tierId, req.params.id);
  res.json({ success: true });
});

app.delete('/api/shops/:id/reward-tiers/:tierId', requireShopAuth, async (req, res) => {
  await db.prepare('DELETE FROM reward_tiers WHERE id = ? AND shop_id = ?').run(req.params.tierId, req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// STRIPE — Créer lien de paiement pour une boutique
// ─────────────────────────────────────────────

app.post('/api/shops/:id/create-payment', requireAdmin, async (req, res) => {
  try {
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) return res.status(404).json({ success: false, error: 'Boutique introuvable' });

    const email = (shop.email || req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email gérant requis' });

    // Nombre de boutiques du gérant, saisi manuellement dans l'admin.
    // 1 seule boutique (ou champ vide) → 29€ flat. 2+ boutiques → 24€ × ce nombre, en une seule ligne à quantité N.
    const shopCount = (shop.manual_shop_count !== null && shop.manual_shop_count !== undefined && Number(shop.manual_shop_count) > 0)
      ? Number(shop.manual_shop_count)
      : 1;
    const isMulti = shopCount >= 2;
    const unitPrice = isMulti ? 2400 : 2900; // centimes : 24€ ou 29€
    const monthlyPrice = unitPrice * (isMulti ? shopCount : 1); // juste pour l'affichage/retour JSON

    // Créer ou récupérer le client Stripe
    let stripeCustomerId = shop.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({ email, name: shop.name, metadata: { shop_id: String(shop.id) } });
      stripeCustomerId = customer.id;
      await db.prepare('UPDATE shops SET stripe_customer_id = ?, email = ? WHERE id = ?').run(stripeCustomerId, email, shop.id);
    }

    // Créer session Stripe Checkout : 80€ installation (sauf si exemptée) + abonnement mensuel
    // Pour un gérant multi-boutiques, une seule ligne d'abonnement à quantité N (24€ × N boutiques)
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
        product_data: { name: 'Abonnement FidélyPass mensuel' + (isMulti ? ' (' + shopCount + ' boutiques × 24€)' : '') },
        unit_amount: unitPrice,
        recurring: { interval: 'month' },
      },
      quantity: isMulti ? shopCount : 1,
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

app.post('/webhook', async (req, res) => {
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
      await db.prepare('UPDATE shops SET active = 1, stripe_subscription_id = ? WHERE id = ?').run(subId || null, shopId);
      console.log('Boutique activée:', shopId);
    }
  }

  if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
    const subId = session.id || (session.subscription);
    if (subId) {
      await db.prepare('UPDATE shops SET active = 0 WHERE stripe_subscription_id = ?').run(subId);
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
    const inactive = await db.prepare(`
      SELECT c.*, s.name as shop_name, s.reward_text, s.points_goal, s.logo_base64
      FROM customers c JOIN shops s ON s.id = c.shop_id
      WHERE c.last_visit IS NOT NULL
        AND c.last_visit <= NOW() - INTERVAL '30 days'
        AND (c.last_reminder_sent IS NULL OR c.last_reminder_sent < c.last_visit)
    `).all();

    for (const customer of inactive) {
      const subs = await db.prepare('SELECT * FROM push_subscriptions WHERE customer_id = ?').all(customer.id);
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
        ).catch(async err => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id).catch(() => {});
          }
        });
      }
      await db.prepare('UPDATE customers SET last_reminder_sent = CURRENT_TIMESTAMP WHERE id = ?').run(customer.id);
    }
    if (inactive.length) console.log('Relance clients inactifs envoyée à', inactive.length, 'client(s)');
  } catch (err) {
    console.log('Erreur relance clients inactifs:', err.message);
  }
}

// Vérifie une première fois 2 minutes après le démarrage, puis toutes les 24h
setTimeout(checkInactiveCustomers, 2 * 60 * 1000);
setInterval(checkInactiveCustomers, 24 * 60 * 60 * 1000);

async function initDatabase() {
  await db.initSchema();

// Recharge les sessions existantes depuis la DB au démarrage (survit aux redéploiements)
try {
  const rows = await db.prepare('SELECT token, shop_id FROM sessions_store').all();
  rows.forEach(r => { sessions[r.token] = r.shop_id; });
  console.log('Sessions rechargées:', rows.length);
} catch (e) {
  console.log('Aucune session à recharger:', e.message);
}

// Migration DB : ajouter colonnes Stripe si elles n'existent pas
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN google_review_url TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN stripe_customer_id TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN stripe_subscription_id TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN active INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN email TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN payment_exempt INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN waive_setup_fee INTEGER DEFAULT 0").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN currency TEXT DEFAULT 'EUR'").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN menu_url TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN menu_file_base64 TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN menu_file_type TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN latitude REAL").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN longitude REAL").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN logo_base64 TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN phone TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN opening_hours TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE shops ADD COLUMN manual_shop_count INTEGER").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE customers ADD COLUMN pass_auth_token TEXT").run();
} catch(e) {}
try {
  await db.prepare("ALTER TABLE customers ADD COLUMN pass_updated_at TEXT").run();
} catch(e) {}
try {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS apple_pass_registrations (
      id SERIAL PRIMARY KEY,
      device_library_id TEXT NOT NULL,
      pass_type_id TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      push_token TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(device_library_id, serial_number)
    )
  `).run();
} catch(e) {}
}

initDatabase().then(() => {
  app.listen(PORT, () => console.log('FidelyPass tourne sur http://localhost:' + PORT));

  // Vérifie une fois par jour si une boutique active n'a pas eu son alerte hebdomadaire depuis
  // 7 jours, et la déclenche si besoin. Volontairement simple (pas de vrai cron externe) puisque
  // ce process Node tourne en continu sur Railway — largement suffisant pour un rythme hebdomadaire.
  setInterval(async () => {
    try {
      const dueShops = await db.prepare(`
        SELECT id FROM shops WHERE active = 1 AND (last_digest_sent_at IS NULL OR last_digest_sent_at < NOW() - INTERVAL '7 days')
      `).all();
      for (const s of dueShops) {
        await runProactiveDigest(s.id).catch(() => {});
      }
    } catch (e) { console.error('Erreur digest hebdomadaire:', e.message); }
  }, 24 * 60 * 60 * 1000);
}).catch(async err => {
  console.error('Erreur initialisation base de données:', err);
  process.exit(1);
});
