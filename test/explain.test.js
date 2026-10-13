// The handler end to end, with Supabase and the Claude API replaced by fakes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/explain.js';

let calls, gateReply, claudeReply;
const USER = '11111111-2222-4333-8444-555555555555';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test';
process.env.ANTHROPIC_API_KEY = 'test';

const RESULT = {
  headline: 'Platform overload', whose_side: 'anthropic', confidence: 'high', likely_cause: 'x', evidence: ['529'],
  fix_steps: ['retry'], retry_guidance: 'yes', docs: [{ url: 'https://platform.claude.com/docs/en/api/errors#http-errors', why: 'codes' }],
  questions_for_customer: [], admin_reply: 'hi', exec_summary: 'ok', escalate_to_engineering: false, escalation_note: '',
};

beforeEach(() => {
  calls = [];
  gateReply = { ok: true, request_id: 7 };
  claudeReply = { status: 200, body: { stop_reason: 'end_turn', model: 'claude-sonnet-5-5', usage: { input_tokens: 3000, output_tokens: 500 }, content: [{ type: 'text', text: JSON.stringify(RESULT) }] } };
  globalThis.fetch = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, headers: opts.headers });
    if (url.endsWith('/auth/v1/user')) return opts.headers.Authorization === 'Bearer good-token-1234567890' ? json({ id: USER, email: 'Tester@Example.com' }) : json({ msg: 'invalid' }, 401);
    if (url.endsWith('/rpc/demo_begin_user')) return json(gateReply);
    if (url.endsWith('/rpc/demo_finish')) return json(null);
    if (url.endsWith('/rpc/demo_user_status')) return json({ status: 'approved', remaining_usd: 4.98 });
    if (url.includes('api.anthropic.com')) return json(claudeReply.body, claudeReply.status);
    throw new Error(`unexpected ${url}`);
  };
});

function json(data, status = 200) {
  return new Response(data === null ? '' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
function run(body, token = 'good-token-1234567890') {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  });
}
const finishCall = () => calls.find((c) => c.url.endsWith('/rpc/demo_finish'))?.body;

test('rejects a visitor who is not signed in, without reserving or calling Claude', async () => {
  for (const token of [null, 'forged-token-0000000000']) {
    calls = [];
    const r = await run({ input: 'HTTP/1.1 529 overloaded_error' }, token);
    assert.equal(r.status, 401);
    assert.ok(!calls.some((c) => c.url.includes('/rpc/') || c.url.includes('anthropic')));
  }
});

test('a pending user is told to wait for approval and Claude is never called', async () => {
  gateReply = { ok: false, reason: 'pending' };
  const r = await run({ input: 'HTTP/1.1 529 overloaded_error' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /approve/);
  assert.ok(!calls.some((c) => c.url.includes('anthropic')));
});

test('stops at the cap and never calls Claude', async () => {
  gateReply = { ok: false, reason: 'global_cap' };
  const r = await run({ input: 'HTTP/1.1 529 overloaded_error' });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /\$15/);
  assert.ok(!calls.some((c) => c.url.includes('anthropic')));
});

test('reserves, calls Claude, and settles to the real cost', async () => {
  const r = await run({ input: 'HTTP/1.1 529\n{"error":{"type":"overloaded_error"}} sk-ant-api03-secretsecret123', ticket: { id: 'API-2001', subject: 's' } });
  assert.equal(r.status, 200);
  const begin = calls.find((c) => c.url.endsWith('/rpc/demo_begin_user')).body;
  assert.equal(begin.p_user_id, USER);
  assert.equal(begin.p_tool, 'api-error-explainer');
  assert.ok(begin.p_max_cost_usd > 0.02 && begin.p_max_cost_usd < 0.1, `reservation ${begin.p_max_cost_usd}`);
  assert.equal(begin.p_ticket_id, 'API-2001');
  assert.deepEqual(finishCall(), { p_request_id: 7, p_ok: true, p_cost_usd: 0.011, p_model: 'claude-sonnet-5-5', p_input_tokens: 3000, p_output_tokens: 500 });
  const sent = calls.find((c) => c.url.includes('anthropic')).body;
  assert.doesNotMatch(sent.messages[0].content, /secretsecret/);
  assert.equal(r.body.redactions, 1);
  assert.equal(r.body.result.docs[0].title, 'API errors: HTTP error codes');
  assert.equal(r.body.remaining_usd, 4.98);
});

test('settles to $0 when the Claude API rejects the call', async () => {
  claudeReply = { status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } };
  const r = await run({ input: 'HTTP/1.1 429 rate_limit_error' });
  assert.equal(r.status, 502);
  assert.equal(finishCall().p_ok, false);
  assert.equal(finishCall().p_cost_usd, 0);
});

test('still charges real usage when the answer is cut off', async () => {
  claudeReply.body = { ...claudeReply.body, stop_reason: 'max_tokens', usage: { input_tokens: 3000, output_tokens: 2500 } };
  const r = await run({ input: 'HTTP/1.1 429 rate_limit_error' });
  assert.equal(r.status, 502);
  assert.equal(finishCall().p_cost_usd, 0.031);
});

test('rejects oversized input before reserving anything', async () => {
  const r = await run({ input: 'x'.repeat(8001) });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});
