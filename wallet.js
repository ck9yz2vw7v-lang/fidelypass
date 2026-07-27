const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { PKPass } = require('passkit-generator');
const forge = require('node-forge');
const { PNG } = require('pngjs');
const http2 = require('http2');

// Assets binaires encodés en base64 (icône + logo par défaut du pass Apple Wallet, utilisés
// si la boutique n'a pas fourni son propre logo)
const PASS_ASSETS = {
  "icon": "iVBORw0KGgoAAAANSUhEUgAAAB0AAAAdCAYAAABWk2cPAAABEElEQVR4nM2WQRLCIAxFQ8eNXsMFh9Cr2YVezR6ii15Dl7qq0/7mh8SW0cywAEIegRCSBOR0fbxwbK107SFN+01toGa3YRM1wSkCvF/2dO58e7rgXXtIyQO0YN/Am5JCBOjV30UXDzkvxo59r65lXlOoB4ZzCGei3il6OQVqhq15zdvFnUaBOI4nol2TGUgeoAdsQlnwIHDI+dMsPWaXesqCA0EMbHlbfKcWoDS+CXQr+X+o58msgrKAQAALNGsjMyjLlRp4bJYes2seb+TBRxLJAoq78oCjuZd+4lYOZuIBigS+NivTRKO3WK5EKweRcslSfKfegiui/5tqcOzUrntHoMjkeLH0rwWcQWuC0e4bxZinS65ewrcAAAAASUVORK5CYII=",
  "icon_2x": "iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAYAAADhu0ooAAACLklEQVR4nO2bTXKDMAyFBdNNc40sOER7tWbRXq05BItcI122KzqMY+v3iQTCW3WKEf4sYQtb6Uiht8/rr6bdvXQ+HTqpDdvg0QFLccDVC2sDLFUD7st/rB2SqM7QSw3WqpKlb13YguZMN6G7VXVE+d78/ngV27x//aQ9/3w6dC9ZxjVwrfYZ0B3Sm1Y4jVDQsHc0AxJpNxy6WYC1Z0S8GwLVQl6GQWxzHEfV87yw7ndUA6kBLKUB9sC6QCVID2ApCdgKawblIBGApThgC6xp1l0aUrJrmQghCUN0spHuvwyD6t3lpA7d1uhJnbR00GtLE8IqUA9kxAMeuxJsytdLNMyi99fkBm2NOqqTLTveSU8EtcxsaE9Y7En9dM263lGt3ecZHM8sDHtHpQe3Bgc5a3NiQWvh4PGmZp1E2OTCF+LRSDKgaYfwaurmmNVTWWkk0RPtAu6gW9MOipB1tszIcSdBQBFLA2KJ4sSC1j59PKMu3YOyyX2qwULXm8p5U0erXEn9cRzTtjKz7Igetey0oTMbi720HQb0h7HWjjcqUpaXKGxGzrvvAtbkhSWKr5MRSCLQBrZmFo6E4+Lfo9zoZaVvqLOX/TRN0lOcj05a+sSbyH+8H65KWaKGYdLdahjmD88ERpTg9JqiXo2yKr8QduGVY/NORTycUjk2/ZFZD3jPWsApYtNqAefKLGjU6j8zQr2rj6Q5U9+6sHaVLDe57hZgawzP/XOQUo8OrInCP2IAQXnSlmpKAAAAAElFTkSuQmCC",
  "icon_3x": "iVBORw0KGgoAAAANSUhEUgAAAFcAAABXCAYAAABxyNlsAAADi0lEQVR4nO2dOXLjMBBFQdck9jUU6BD21exg5mr2IRj4Gp7QDlyskigC7OX3Iql/KhLLw1cTJIHm1BR6/vv1rTn/GvTx9jRJz2WfeA9Ae+KCJh98z1DXokJ+oBxUYM9F5TEcgYK6r5GLu84tsDSNOG3CLbA89XhdwC2wMm1xI13QSjKdwS3X6rTmN/V+iNb76yP52Jd//w1bwtcyg/gT3ZBFHJh752aBPbUW51oNUKqiQH+8PU0hzvWAuq4rArIrXE+ovbo9IU8eISESak8ekM3nuRnBtubTLtOwoOnA5/FIPvYwz6I63l8fTR1sEhakUDlAe5KCtoAMh8sFiwDaExc0GjAULgesJdS1OJCRgGEXtKxgufUhL3TuT8W8wUbWCwkLlNGOgrolSphAhAe1c68NbGu09iDCg8q51mApDrMuX+Ng05sISce506fT47n1fR6P4nkxReKwgL59PMyzuqOIMtbS9NNstuBx+4ooz/J6IIK7N5qRYCXl7rVX6l64czOAlZRv4WA2XFSstQaLrkfSb6hzqaPvBZZbH9q97u/QuGBHHeaUdZhn95sZlnO1IYEbA/dgUI6R1r8lbv9hYQHpCsnNQFTdI7k9FbOOexnjfaqFeFrXZHtARIY7ijeITqHAWLeFE3ddnOs99dqTV3tShAX03zlLeEgB91ZVcA1VcA1VcA1VcA1VcA2VAm7kax5LucDNMu9c5NUeMtzR+3uEU1Bus24LZx1DirCwCPFqPZPc4Fo/Eox6lTMSDC7SNZpVN951j8SCq135x30ls9dR7gobrWu5/Xd/Qcldn4VyUsSMBRpzM8Y9Tn3oCyIbLmrPgBdgVD2SfsNnC9FLiKTlW0zjRHD3RjEDYCRY6b/VbJ4bCTjasYvEcNEb4rirZ6zKWCvtsn3J+qzT4zPsidBIvVXqGnfztOazXUodcykNyPZAxWsfGmzvL3UlSqSLqYOMup64P3KMcnFEvTC4nNHOurK8NewsqPItnCh1voVFlSnkV6bZmbLnuGnNNkuTeeqrrNmZWrNPf2U+W8iSV3Etj3a55nLM4GKvwXbP5bh0LALyzedyXOQJOTIspUlOjAQdHefTJSdeA7nmzM+Lzj4gEe3eW9DpRzkeej+U+FrzS7UQ79Z0AbfcK9MWt03nFmCeery6YaEA0zTiRAJYs4hLUcxHuqCVi89F5VHfoGTI7BuUW7oH0Jp/7Q+qVdgzr4BeIQAAAABJRU5ErkJggg==",
  "logo": "iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAB0UlEQVR4nO2aSVLDMBBFpRQbco0sfAi4GlnA1cghvMg1whJWooJLPfzu75RM8lcuW0M/dWt2LYZe3i/fVppb6HTcV+27+HEUgKUkoF3v5agQpci2VU+iUXXtna5HtqhfkK15o5S/NtflC4Y+357NNK8fX7T6Tsd9fWIV5jFeSs+AqllvoACaMkCpzs6EyJYXCi1PhedpEr8d5tksG/UOHFoahGa8JA0KgYFAJIgIwFISkBfG3UfWhNDK8fabVGdnQTDKc4VWr1WsSrXYj+S1QswEQSE0gGw5GgwcWiwIKz0aZioIMkGhEJF8mj2QR6RWikJY+RGvpBeNaHhI6Q/znBq1RI9k11GSUdkhW7LLHVpI61rGIiHqBadvdb0VsyfT/7dn37oeIKOJDuKdHLOT6FJuEGRotIxEhm0vsAiSPaLRZvCMJLvSS5TzNFGMzs4rUB9hLO6Q/EhDqCBIeEVhkHzUjRVzM8TcpN3Pnr0pAhNRBKKU5ITIntQy5blBpFZhwWRPGu/z7LdpzdP4ptVP46/Fvh8pJb402ll/FKxRKbs8yh1iqzzjHcodYntg3uze8la3RdTjz4fR1O3oo3umN0B1PZIZydaWZJtp8CjesRr3B1VeDn9wcsKKAAAAAElFTkSuQmCC",
  "logo_2x": "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAEHUlEQVR4nO2dPXLcMAyFuZ409jW20CGSq9lFcjX7ECr2Gk6ZVJrZ1eqHIPDwQAmv9ZqE8BEAKVHUpRjp5+/vf1Zt9aivj7eLRTuqRs4OYU0aOOJ/TAgySeG8SH6cMOSS+qyKXoKwUU207EZIwrBTjS83gSQMe+35dBVIwsBpy7eLQBIGXms+fgKSMPy05GvRtDeF1wOQjA5/zX1+WftDVH2+v4r/59efvwBLbDWtUX6wDdlTC4C9NiIDCgnEAkJt+9HgXEqJk67QILYUAczXx9slRIQwQcxtYIOhAokAYi42mAsjXUUEsSZvMO4Lw55glOJvr2vKsrq42zBU//Y6jur+Pt9f3SLFJWVpQUgA7EkLCA0GDkQDwxLEXBowSChQIC0wkBDW1AIHBQVW1HuB0dovqthDIkRqLAvEkqTRYh0p9OchkWCUwrfHHIgkOtgXvyaJXdapyxTIEWBMYkExA3IkGJMYUNxvLlrBqCm+Fn3dhsFktV8rk1lW7ejQOkjjGK++tbMut1mWxiHXcVSPUm0bXmlWHSE10dF6MchUgbRJEyX0dcia0Hnbsy5IpAKCig4vZ7X0U3M9mhkXNEIiw9D0h6wnzUAQN9dYaQTRb6t/wtQQdk5n9z8JtjD0eMy61UdLm9dxrLYbtWBsihD2RoXbMOw6ruY3aLX4CZKykNEhdbL09xJ7EMBD7Fyskebip/+NUie2RC3qUR3EtEsMhFE/rFIDo6ZI/WUeIdYXfbb2aCkrarqaxLIvzMJwSagUw54Obyk0kDMqgQRTAgmmBBJMCSSYEkgwhQaCWgtEXgPRgEReC5TCs88ciPXoO1t7YiCM97etLpqRqqT+otaQqGmLaVc3D6im0d3D1iKNIBGCfAwqdS7yEXGYTQ7sA1pqNk5bbNDWqsVPsJTlsaXG2uHs6Cgl0MKQXeDZ/U9qBoJIWz29p76nVv9AIyTaRmar/pC1SQWkZhREhoKCccgXdtBQotSMudxe+tS+Y2gltB3dvPSpfeFSO6K1bXitacwOn/F6NXqS13vqtX2VYjPzdL+XJVkwbsmrBniv9s1SlmR0sG9p1Epip9W6zLSGHAkKA0YpgKJ+BCgsGKUEWIdEg8K2B3YIZk9nLpYS5yBMWIS0GNvTe+qoZ0J5bm+Duj23d1KebF0v168j9Hr2eyl+j63dP1fBPnSgRZ57CF40H2NvEXuDhFSe9tI+eTRdZORoYQ0c6ka5iGDYERzqw5Jn/kpbyA9LMiKGDWKuUEAm3TsJAScahHs9zLAipK09HfFbuPcz3acpbw9QjqT5soN++z31qCcg3gvFM2vJ14sRklDwWvPxaspKKDht+XazhiQUe+35dLeoJxQ71fhS5OycErdJMqhF096MFrmkPlM5OCNmWZqBazbizw7HKnv8B0KJHvF4BxUvAAAAAElFTkSuQmCC",
  "logo_3x": "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",
};

const APPLE_WWDR_CERT_BASE64 = "MIIEVTCCAz2gAwIBAgIUE9x3lVJx5T3GMujM/+Uh88zFztIwDQYJKoZIhvcNAQELBQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBSb290IENBMB4XDTIwMTIxNjE5MzYwNFoXDTMwMTIxMDAwMDAwMFowdTFEMEIGA1UEAww7QXBwbGUgV29ybGR3aWRlIERldmVsb3BlciBSZWxhdGlvbnMgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxCzAJBgNVBAsMAkc0MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANAfeKp6JzKwRl/nF3bYoJ0OKY6tPTKlxGs3yeRBkWq3eXFdDDQEYHX3rkOPR8SGHgjov9Y5Ui8eZ/xx8YJtPH4GUnadLLzVQ+mxtLxAOnhRXVGhJeG+bJGdayFZGEHVD41tQSo5SiHgkJ9OE0/QjJoyuNdqkh4laqQyziIZhQVg3AJK8lrrd3kCfcCXVGySjnYB5kaP5eYq+6KwrRitbTOFOCOL6oqW7Z+uZk+jDEAnbZXQYojZQykn/e2kv1MukBVlPNkuYmQzHWxq3Y4hqqRfFcYw7V/mjDaSlLfcOQIA+2SM1AyB8j/VNJeHdSbCb64DYyEMe9QbsWLFApy9/a8CAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJvb3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290LmNybDAdBgNVHQ4EFgQUW9n6HeeaGgujmXYiUIY+kchbd6gwDgYDVR0PAQH/BAQDAgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBCwUAA4IBAQA/Vj2e5bbDeeZFIGi9v3OLLBKeAuOugCKMBB7DUshwgKj7zqew1UJEggOCTwb8O0kU+9h0UoWvp50h5wESA5/NQFjQAde/MoMrU1goPO6cn1R2PWQnxn6NHThNLa6B5rmluJyJlPefx4elUWY0GzlxOSTjh2fvpbFoe4zuPfeutnvi0v/fYcZqdUmVIkSoBPyUuAsuORFJEtHlgepZAE9bPFo22noicwkJac3AfOriJP6YRLj477JxPxpd1F1+M02cHSS+APCQA1iZQT0xWmJArzmoUUOSqwSonMJNsUvSq3xKX+udO7xPiEAGE/+QF4oIRynoYpgppU8RBWk6z/Kf";

const ISSUER_ID = '3388000000023164162';
const CLASS_ID = 'fidelypass_loyalty';
const APPLE_PASS_TYPE_ID = 'pass.com.fidelypass.loyalty';

function getCredentials() {
  const b64 = process.env.GOOGLE_WALLET_KEY_BASE64;
  if (!b64) throw new Error('GOOGLE_WALLET_KEY_BASE64 non définie');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function normalizeHexColor(hex) {
  hex = (hex || '#3b82f6').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return '#' + hex.padEnd(6, '0').slice(0, 6);
}

// Crée (ou met à jour) une classe Google Wallet propre à CETTE boutique — nom, couleur, logo,
// lien menu — pour que la carte Google ressemble à la carte Apple au lieu d'être générique.
// Note : une classe nouvellement créée passe par une revue de Google avant d'être pleinement
// publique ; elle reste utilisable pour les tests avec le même compte émetteur entre-temps.
async function ensureShopLoyaltyClass(customer) {
  const classId = `${ISSUER_ID}.fidelypass_shop_${customer.shop_id}`;

  const classResource = {
    id: classId,
    issuerName: 'FidélyPass',
    programName: customer.shop_name || 'FidélyPass',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: normalizeHexColor(customer.color),
  };

  if (customer.logo_base64) {
    classResource.programLogo = {
      sourceUri: { uri: `https://fidelypass-production.up.railway.app/shops/${customer.shop_id}/logo-file` },
      contentDescription: { defaultValue: { language: 'fr', value: customer.shop_name || 'FidélyPass' } },
    };
  }
  if (customer.menu_url) {
    classResource.homepageUri = {
      uri: customer.menu_url,
      description: 'Notre menu',
    };
  }

  try {
    await google.walletobjects('v1').loyaltyclass.get({ resourceId: classId });
    await google.walletobjects('v1').loyaltyclass.patch({ resourceId: classId, requestBody: classResource });
  } catch (e) {
    await google.walletobjects('v1').loyaltyclass.insert({ requestBody: classResource });
  }

  return classId;
}

async function createWalletPass(customer) {
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const client = await auth.getClient();
  google.options({ auth: client });

  const classId = await ensureShopLoyaltyClass(customer);
  const objectId = `${ISSUER_ID}.fidelypass_${customer.id}`;
  const remaining = Math.max(0, (customer.points_goal || 0) - (customer.points || 0));

  const textModulesData = [
    { id: 'reward', header: 'Récompense', body: customer.reward_text || 'Non définie' },
    { id: 'remaining', header: 'Restant', body: remaining + ' pts' },
  ];
  if (customer.opening_hours) {
    textModulesData.push({ id: 'hours', header: 'Horaires', body: customer.opening_hours });
  }

  const linksModuleData = { uris: [] };
  if (customer.menu_url) linksModuleData.uris.push({ uri: customer.menu_url, description: '📋 Notre menu' });
  if (customer.google_review_url) linksModuleData.uris.push({ uri: customer.google_review_url, description: '⭐ Laisser un avis' });
  if (customer.phone) linksModuleData.uris.push({ uri: 'tel:' + customer.phone.replace(/\s/g, ''), description: '📞 Nous appeler' });

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountId: String(customer.id),
    accountName: customer.name,
    loyaltyPoints: {
      label: 'Points sur ' + (customer.points_goal || 0),
      balance: { int: customer.points || 0 },
    },
    textModulesData,
    barcode: {
      type: 'QR_CODE',
      value: `https://fidelypass-production.up.railway.app/card/${customer.id}`,
    },
  };
  if (linksModuleData.uris.length) loyaltyObject.linksModuleData = linksModuleData;

  try {
    await google.walletobjects('v1').loyaltyobject.get({ resourceId: objectId });
    await google.walletobjects('v1').loyaltyobject.patch({
      resourceId: objectId,
      requestBody: loyaltyObject,
    });
  } catch (e) {
    await google.walletobjects('v1').loyaltyobject.insert({
      requestBody: loyaltyObject,
    });
  }

  const claims = {
    iss: credentials.client_email,
    aud: 'google',
    typ: 'savetowallet',
    payload: { loyaltyObjects: [{ id: objectId }] },
  };

  const token = jwt.sign(claims, credentials.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

function hexToRgbParts(hex) {
  hex = (hex || '#3b82f6').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.substring(0, 2), 16) || 59;
  const g = parseInt(hex.substring(2, 4), 16) || 130;
  const b = parseInt(hex.substring(4, 6), 16) || 246;
  return { r, g, b };
}

function hexToRgb(hex) {
  const { r, g, b } = hexToRgbParts(hex);
  return `rgb(${r},${g},${b})`;
}

// Génère une bannière (strip) avec un dégradé vertical + une légère touche de lumière en haut à
// gauche, pour un rendu moins plat qu'un aplat uni
function generateStripPng(hex, width, height) {
  const { r, g, b } = hexToRgbParts(hex);
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const t = y / height; // 0 (haut) -> 1 (bas)
    const verticalFactor = 1 + (1 - t) * 0.22;
    for (let x = 0; x < width; x++) {
      const dx = x / width;
      const dy = y / height;
      const dist = Math.sqrt(dx * dx * 0.6 + dy * dy * 0.25);
      const highlight = Math.max(0, 1 - dist * 1.3) * 0.16;
      const factor = verticalFactor + highlight;
      const rr = Math.min(255, Math.round(r * factor));
      const gg = Math.min(255, Math.round(g * factor));
      const bb = Math.min(255, Math.round(b * factor));
      const idx = (width * y + x) << 2;
      png.data[idx] = rr;
      png.data[idx + 1] = gg;
      png.data[idx + 2] = bb;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// Redimensionne (plus proche voisin, sans dépendance externe) une image PNG uploadée par le
// commerçant pour produire les 3 résolutions attendues par Apple (@1x/@2x/@3x), en conservant
// les proportions et en plafonnant la largeur au format attendu pour un logo de carte
function resizePngBuffer(srcBuffer, targetHeight, maxWidth) {
  const src = PNG.sync.read(srcBuffer);
  const scale = targetHeight / src.height;
  let targetWidth = Math.round(src.width * scale);
  if (targetWidth > maxWidth) targetWidth = maxWidth;
  if (targetWidth < 1) targetWidth = 1;
  const dst = new PNG({ width: targetWidth, height: targetHeight });
  const scaleX = src.width / targetWidth;
  const scaleY = src.height / targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * scaleY));
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * scaleX));
      const srcIdx = (src.width * sy + sx) << 2;
      const dstIdx = (targetWidth * y + x) << 2;
      dst.data[dstIdx] = src.data[srcIdx];
      dst.data[dstIdx + 1] = src.data[srcIdx + 1];
      dst.data[dstIdx + 2] = src.data[srcIdx + 2];
      dst.data[dstIdx + 3] = src.data[srcIdx + 3];
    }
  }
  return PNG.sync.write(dst);
}

// Construit les 3 fichiers logo (@1x/@2x/@3x) à partir du logo base64 fourni par la boutique.
// Retourne null si aucun logo n'est fourni, ou s'il n'a pas pu être décodé (doit être un PNG valide)
function buildShopLogoFiles(logoBase64) {
  if (!logoBase64) return null;
  try {
    const raw = logoBase64.includes(',') ? logoBase64.split(',').pop() : logoBase64;
    const buf = Buffer.from(raw, 'base64');
    return {
      'logo.png': resizePngBuffer(buf, 50, 160),
      'logo@2x.png': resizePngBuffer(buf, 100, 320),
      'logo@3x.png': resizePngBuffer(buf, 150, 480),
    };
  } catch (e) {
    console.error('Logo boutique invalide (PNG attendu), utilisation du logo par défaut:', e.message);
    return null;
  }
}

// Petite barre de progression textuelle (compatible avec le rendu des cartes Apple Wallet)
function progressBarText(points, goal) {
  const safeGoal = goal > 0 ? goal : 1;
  const ratio = Math.max(0, Math.min(1, points / safeGoal));
  const totalBlocks = 10;
  const filled = Math.round(ratio * totalBlocks);
  return '█'.repeat(filled) + '░'.repeat(totalBlocks - filled) + '  ' + Math.round(ratio * 100) + '%';
}

// Extrait le certificat et la clé privée depuis le fichier .p12 (une seule fois, mis en cache)
let _appleCertsCache = null;
function getAppleCertificates() {
  if (_appleCertsCache) return _appleCertsCache;

  const p12b64 = process.env.APPLE_WALLET_P12_BASE64;
  const p12Password = process.env.APPLE_WALLET_P12_PASSWORD;
  if (!p12b64 || !p12Password) {
    throw new Error('Variables APPLE_WALLET_P12_BASE64 / APPLE_WALLET_P12_PASSWORD manquantes');
  }

  const p12Buffer = Buffer.from(p12b64, 'base64');
  const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, p12Password);

  let certPem = null, keyPem = null;
  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (safeBag.type === forge.pki.oids.certBag) {
        certPem = forge.pki.certificateToPem(safeBag.cert);
      } else if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        keyPem = forge.pki.privateKeyToPem(safeBag.key);
      }
    }
  }
  if (!certPem || !keyPem) throw new Error('Impossible d\'extraire le certificat/clé du fichier .p12');

  const wwdrDer = Buffer.from(APPLE_WWDR_CERT_BASE64, 'base64');
  const wwdrAsn1 = forge.asn1.fromDer(wwdrDer.toString('binary'));
  const wwdrCert = forge.pki.certificateFromAsn1(wwdrAsn1);
  const wwdrPem = forge.pki.certificateToPem(wwdrCert);

  _appleCertsCache = {
    wwdr: Buffer.from(wwdrPem, 'utf-8'),
    signerCert: Buffer.from(certPem, 'utf-8'),
    signerKey: Buffer.from(keyPem, 'utf-8'),
  };
  return _appleCertsCache;
}

async function createApplePassBuffer(customer) {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) throw new Error('Variable APPLE_TEAM_ID manquante');

  const certificates = getAppleCertificates();

  const remaining = Math.max(0, (customer.points_goal || 0) - (customer.points || 0));

  const backFields = [
    { key: 'reward', label: 'Récompense', value: customer.reward_text || 'Non définie' },
    { key: 'info', label: 'Comment ça marche', value: 'Montrez cette carte à chaque achat pour cumuler des points et débloquer votre récompense.' },
  ];
  if (customer.menu_url) {
    backFields.push({ key: 'menu', label: 'Notre menu', value: customer.menu_url });
  }
  if (customer.phone) {
    backFields.push({ key: 'phone', label: 'Nous appeler', value: customer.phone });
  }
  if (customer.opening_hours) {
    backFields.push({ key: 'hours', label: 'Horaires', value: customer.opening_hours });
  }

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: APPLE_PASS_TYPE_ID,
    teamIdentifier: teamId,
    organizationName: customer.shop_name || 'FidélyPass',
    logoText: customer.shop_name || 'FidélyPass',
    serialNumber: 'fidelypass-' + customer.id,
    description: (customer.shop_name || 'FidélyPass') + ' - Carte de fidélité',
    backgroundColor: hexToRgb(customer.color),
    foregroundColor: 'rgb(255,255,255)',
    labelColor: 'rgb(255,255,255)',
    storeCard: {
      headerFields: [
        { key: 'goal', label: 'OBJECTIF', value: customer.points_goal + ' pts' }
      ],
      primaryFields: [
        { key: 'points', label: 'POINTS', value: customer.points + ' / ' + customer.points_goal }
      ],
      secondaryFields: [
        { key: 'name', label: 'CLIENT', value: customer.name }
      ],
      auxiliaryFields: [
        { key: 'remaining', label: 'RESTANT', value: remaining + ' pts' },
        { key: 'progress', label: 'PROGRESSION', value: progressBarText(customer.points, customer.points_goal) }
      ],
      backFields
    },
    barcodes: [{
      message: 'fidelypass:customer:' + customer.id,
      format: 'PKBarcodeFormatQR',
      messageEncoding: 'iso-8859-1'
    }]
  };

  // Mise à jour automatique de la carte (nécessite un jeton d'authentification par client)
  if (customer.pass_auth_token) {
    passJson.webServiceURL = 'https://fidelypass-production.up.railway.app/apple-wallet';
    passJson.authenticationToken = customer.pass_auth_token;
  }

  // Apparition automatique sur l'écran verrouillé à proximité de la boutique (si coordonnées fournies)
  if (customer.latitude != null && customer.longitude != null) {
    passJson.locations = [{
      latitude: customer.latitude,
      longitude: customer.longitude,
      relevantText: `Vous êtes près de ${customer.shop_name || 'la boutique'} — montrez votre carte !`
    }];
  }

  const shopLogoFiles = buildShopLogoFiles(customer.logo_base64);

  const pass = new PKPass({
    'pass.json': Buffer.from(JSON.stringify(passJson)),
    'icon.png': Buffer.from(PASS_ASSETS.icon, 'base64'),
    'icon@2x.png': Buffer.from(PASS_ASSETS.icon_2x, 'base64'),
    'icon@3x.png': Buffer.from(PASS_ASSETS.icon_3x, 'base64'),
    'logo.png': shopLogoFiles ? shopLogoFiles['logo.png'] : Buffer.from(PASS_ASSETS.logo, 'base64'),
    'logo@2x.png': shopLogoFiles ? shopLogoFiles['logo@2x.png'] : Buffer.from(PASS_ASSETS.logo_2x, 'base64'),
    'logo@3x.png': shopLogoFiles ? shopLogoFiles['logo@3x.png'] : Buffer.from(PASS_ASSETS.logo_3x, 'base64'),
    'strip.png': generateStripPng(customer.color, 375, 123),
    'strip@2x.png': generateStripPng(customer.color, 750, 246),
    'strip@3x.png': generateStripPng(customer.color, 1125, 369),
  }, certificates);

  return pass.getAsBuffer();
}

// Envoie une notification push "silencieuse" à un appareil pour lui dire de récupérer la carte
// à jour (protocole PassKit officiel — payload vide, l'iPhone va chercher la nouvelle version
// via GET /apple-wallet/v1/passes/...)
function sendApplePushNotification(pushToken) {
  return new Promise((resolve, reject) => {
    let certificates;
    try {
      certificates = getAppleCertificates();
    } catch (e) {
      return reject(e);
    }

    const client = http2.connect('https://api.push.apple.com', {
      cert: certificates.signerCert,
      key: certificates.signerKey,
    });

    const timeout = setTimeout(() => {
      client.close();
      reject(new Error('Push Apple Wallet: délai dépassé'));
    }, 8000);

    client.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + pushToken,
      'apns-topic': APPLE_PASS_TYPE_ID,
      'content-type': 'application/json',
    });

    let status = 0;
    let body = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      clearTimeout(timeout);
      client.close();
      if (status >= 200 && status < 300) resolve(true);
      else reject(new Error('Push Apple Wallet échoué: ' + status + ' ' + body));
    });
    req.on('error', (err) => { clearTimeout(timeout); client.close(); reject(err); });
    req.end(JSON.stringify({}));
  });
}

module.exports = { createWalletPass, createApplePassBuffer, sendApplePushNotification };
