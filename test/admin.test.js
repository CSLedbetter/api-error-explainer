import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/admin.js';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test';
process.env.ADMIN_EMAIL = 'owner@example.com';
let calls;
const users = { 'Bearer owner-token-1234567890': 'Owner@Example.com', 'Bearer guest-token-1234567890': 'guest@example.com' };
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (url.endsWith('/auth/v1/user')) {
      const email = users[opts.headers.Authorization];
      return email ? json({ id: '11111111-2222-4333-8444-555555555555', email }) : json({}, 401);
    }
    if (url.endsWith('/rpc/demo_admin_list')) return json({ users: [], settings: {} });
    if (url.endsWith('/rpc/demo_admin_set')) return json({ ok: true });
    throw new Error(url);
  };
});
const run = (method, token, body) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); } };
  handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
});
const touchedAdmin = () => calls.some((c) => c.url.includes('/rpc/demo_admin'));

test('only the owner can list or change access', async () => {
  assert.equal((await run('GET', null)).status, 401);
  assert.equal((await run('GET', 'guest-token-1234567890')).status, 403);
  assert.equal((await run('POST', 'guest-token-1234567890', { action: 'set', user_id: '11111111-2222-4333-8444-555555555555', status: 'approved' })).status, 403);
  assert.ok(!touchedAdmin());
  assert.equal((await run('GET', 'owner-token-1234567890')).status, 200);
});

test('validates approvals and caps', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal((await run('POST', 'owner-token-1234567890', { action: 'set', user_id: 'nope', status: 'approved' })).status, 400);
  assert.equal((await run('POST', 'owner-token-1234567890', { action: 'set', user_id: id, status: 'approved', cap_usd: 50 })).status, 400);
  const ok = await run('POST', 'owner-token-1234567890', { action: 'set', user_id: id, status: 'approved', cap_usd: 5 });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.at(-1).body, { p_user_id: id, p_status: 'approved', p_cap_usd: 5 });
});
