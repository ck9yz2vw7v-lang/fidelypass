const { google } = require('googleapis');
const jwt = require('jsonwebtoken');

const ISSUER_ID = '3388000000023164162';
const CLASS_ID = 'fidelypass_loyalty';

function getCredentials() {
  const b64 = process.env.GOOGLE_WALLET_KEY_BASE64;
  if (!b64) throw new Error('GOOGLE_WALLET_KEY_BASE64 non définie');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function createWalletPass(customer) {
  const credentials = getCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const client = await auth.getClient();
  google.options({ auth: client });

  const objectId = `${ISSUER_ID}.fidelypass_${customer.id}`;

  const loyaltyObject = {
    id: objectId,
    classId: `${ISSUER_ID}.${CLASS_ID}`,
    state: 'ACTIVE',
    accountId: String(customer.id),
    accountName: customer.name,
    loyaltyPoints: {
      label: 'Points',
      balance: { int: customer.points || 0 },
    },
    barcode: {
      type: 'QR_CODE',
      value: `https://fidelypass-production.up.railway.app/card/${customer.id}`,
    },
  };

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

module.exports = { createWalletPass };