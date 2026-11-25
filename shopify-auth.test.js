const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(post, env = {}) {
  let now = 1000000;
  const context = {
    require: () => ({ post }),
    module: { exports: {} },
    process: { env: {
      SHOPIFY_SHOP_DOMAIN: 'test-store.myshopify.com',
      SHOPIFY_CLIENT_ID: 'test-client',
      SHOPIFY_CLIENT_SECRET: 'test-secret',
      ...env
    } },
    Date: { now: () => now },
    URLSearchParams
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./shopify-auth'), 'utf8'), context);
  return { getAccessToken: context.module.exports.getAccessToken, advance: ms => { now += ms; } };
}

test('exchanges client credentials, caches tokens, and renews before expiry', async () => {
  let calls = 0;
  const auth = setup(async (url, body, config) => {
    calls++;
    assert.equal(url, 'https://test-store.myshopify.com/admin/oauth/access_token');
    const params = new URLSearchParams(body);
    assert.equal(params.get('grant_type'), 'client_credentials');
    assert.equal(params.get('client_id'), 'test-client');
    assert.equal(params.get('client_secret'), 'test-secret');
    assert.equal(config.maxRedirects, 0);
    return { data: { access_token: `token-${calls}`, expires_in: 3600 } };
  });
  assert.equal(await auth.getAccessToken(), 'token-1');
  auth.advance(3539000);
  assert.equal(await auth.getAccessToken(), 'token-1');
  auth.advance(1000);
  assert.equal(await auth.getAccessToken(), 'token-2');
  assert.equal(calls, 2);
});

test('concurrent callers share one token request', async () => {
  let calls = 0;
  let finish;
  const auth = setup(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = auth.getAccessToken();
  const second = auth.getAccessToken();
  finish({ data: { access_token: 'shared-token', expires_in: 86400 } });
  assert.deepEqual(await Promise.all([first, second]), ['shared-token', 'shared-token']);
  assert.equal(calls, 1);
});

test('authentication failures redact request secrets and allow retry', async () => {
  let calls = 0;
  const auth = setup(async () => {
    if (++calls === 1) {
      throw Object.assign(new Error('test-secret'), {
        response: { status: 401, data: 'test-secret' },
        config: { data: 'test-secret' }
      });
    }
    return { data: { access_token: 'recovered', expires_in: 3600 } };
  });
  await assert.rejects(auth.getAccessToken(), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('test-secret'));
    assert.equal(error.config, undefined);
    assert.equal(error.response, undefined);
    return true;
  });
  assert.equal(await auth.getAccessToken(), 'recovered');
});

test('rejects missing credentials and unsafe hosts before sending secrets', async () => {
  const post = async () => { assert.fail('must not send a request'); };
  await assert.rejects(setup(post, { SHOPIFY_CLIENT_SECRET: '' }).getAccessToken(), /SHOPIFY_CLIENT_SECRET/);
  await assert.rejects(setup(post, { SHOPIFY_SHOP_DOMAIN: 'example.com' }).getAccessToken(), /hostname/);
});

test('rejects invalid token responses instead of caching them', async () => {
  for (const data of [{}, { access_token: 'token', expires_in: 0 }, { access_token: 'token', expires_in: 'invalid' }]) {
    const auth = setup(async () => ({ data }));
    await assert.rejects(auth.getAccessToken(), /authentication failed/);
  }
});
