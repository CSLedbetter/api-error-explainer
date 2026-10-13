// The handler end to end, with Supabase and the Claude API replaced by fakes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/explain.js';

let calls, gateReply, claudeReply;
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
  gateReply = { ok: true, request_id: 7, label: 'Tester' };
  claudeReply = { status: 200, body: { stop_reason: 'end_turn', model: 'claude-sonnet-5-5', usage: { input_tokens: 3000, output_tokens: 500 }, content: [{ type: 'text', text: JSON.stringify(RESULT) }] } };
  globalThis.fetch = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, headers: opts.headers });
    if (url.endsWith('/rpc/demo_begin')) return json(gateReply);
    if (url.endsWith('/rpc/demo_finish')) return json(null);
    if (url.endsWith('/rpc/demo_check_code')) return json({ ok: true, label: 'Tester', remaining_usd: 4.98 });
    if (url.includes('api.anthropic.com')) return json(claudeReply.body, claudeReply.status);
    throw new Error(`unexpected ${url}`);
  };
});

function json(data, status = 200) {
  return new Response(data === null ? '' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
function run(body, code = '1a2b-3c4d-5e6f-7a8b') {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); } };
    handler({ method: 'POST', headers: code ? { 'x-access-code': code } : {}, body }, res);
  });
}
const finishCall = () => calls.find((c) => c.url.endsWith('/rpc/demo_finish'))?.body;

test('rejects a missing code without touching Supabase or Claude', async () => {
  const r = await run({ input: 'HTTP/1.1 529 overloaded_error' }, null);
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
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
  const begin = calls.find((c) => c.url.endsWith('/rpc/demo_begin')).body;
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
