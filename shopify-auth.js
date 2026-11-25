const axios = require('axios');

let cachedToken = null;
let refreshAt = 0;
let pendingTokenRequest = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < refreshAt) return cachedToken;
  if (pendingTokenRequest) return pendingTokenRequest;

  const shop = (process.env.SHOPIFY_SHOP_DOMAIN || '').trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();

  if (!shop || !clientId || !clientSecret) {
    throw new Error('Set SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in environment variables');
  }
  // Only send app credentials to a Shopify store host, never a redirect or custom domain.
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be a hostname such as your-store.myshopify.com (without https:// or a path)');
  }

  pendingTokenRequest = (async () => {
    try {
      const requestedAt = Date.now();
      const response = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
          maxRedirects: 0
        }
      );

      const { access_token: token, expires_in: expiresIn } = response.data || {};
      const lifetimeMs = Number(expiresIn) * 1000;
      if (typeof token !== 'string' || !token || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
        throw new Error('Shopify returned an invalid access token or expiry');
      }

      cachedToken = token;
      refreshAt = requestedAt + lifetimeMs - Math.min(60000, lifetimeMs * 0.1);
      return cachedToken;
    } catch (error) {
      // Axios errors contain the request body (including the client secret).
      // Return a clean error so callers can safely log it.
      const status = error.response?.status;
      throw new Error(status
        ? `Shopify client credentials authentication failed (HTTP ${status}). Check the credentials, app installation, and organization access.`
        : 'Shopify client credentials authentication failed. Check the credentials, shop domain, and network connection.');
    }
  })();

  try {
    return await pendingTokenRequest;
  } finally {
    pendingTokenRequest = null;
  }
}

module.exports = { getAccessToken };
