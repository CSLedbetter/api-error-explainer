import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, redact, DOCS } from '../lib/catalog.js';
import { SCHEMA } from '../lib/prompt.js';

const tickets = JSON.parse(readFileSync(new URL('../public/tickets.json', import.meta.url)));
const byId = Object.fromEntries(tickets.map((t) => [t.id, t]));

test('parses status, type and request ID from each sample ticket', () => {
  const expect = {
    'API-2001': [529, 'overloaded_error'], 'API-2002': [429, 'rate_limit_error'], 'API-2003': [429, 'rate_limit_error'],
    'API-2004': [400, 'invalid_request_error'], 'API-2005': [401, 'authentication_error'], 'API-2006': [413, 'request_too_large'],
    'API-2007': [504, 'timeout_error'], 'API-2008': [403, 'permission_error'],
  };
  for (const [id, [status, type]] of Object.entries(expect)) {
    const f = parse(byId[id].body);
    assert.equal(f.http_status, status, id);
    assert.equal(f.error_type, type, id);
    assert.match(f.request_id, /^req_/, id);
  }
});

test('tells a spend-cap 429 apart from a rate-limit 429', () => {
  assert.equal(parse(byId['API-2003'].body).spend_cap, true);
  const rl = parse(byId['API-2002'].body);
  assert.equal(rl.spend_cap, false);
  assert.equal(rl.retry_after_seconds, 12);
  assert.ok(rl.ratelimit_headers.some((h) => h.startsWith('anthropic-ratelimit-input-tokens-remaining: 0')));
});

test('does not read dollar amounts as status codes', () => {
  const f = parse('We bought $500 in credits and nothing works.');
  assert.equal(f.http_status, undefined);
});

test('removes API keys before anything is sent', () => {
  const { text, redactions } = redact('key sk-ant-api03-AbCdEf123456789_xyz and x-api-key: sk-live-abcdefghijklmnop');
  assert.equal(redactions, 2);
  assert.doesNotMatch(text, /AbCdEf|abcdefghijklmnop/);
});

test('Claude can only cite pages from the checked doc list', () => {
  assert.deepEqual(SCHEMA.properties.docs.items.properties.url.enum, DOCS.map((d) => d.url));
});
