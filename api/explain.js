import { readCode, begin, finish, checkCode, maxCost, actualCost, REASONS, PRICES } from '../lib/gate.js';
import { parse, redact, DOCS } from '../lib/catalog.js';
import { callClaude, DEFAULT_MODEL } from '../lib/claude.js';
import { SYSTEM, SCHEMA, userMessage } from '../lib/prompt.js';

const MAX_INPUT = 8000;
const MAX_TOKENS = 2500;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const code = readCode(req);
  if (!code) return res.status(401).json({ error: REASONS.invalid_code.message, reason: 'invalid_code' });

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const raw = typeof body.input === 'string' ? body.input.trim() : '';
  if (raw.length < 10) return res.status(400).json({ error: 'Paste an error, log lines, or a ticket first.' });
  if (raw.length > MAX_INPUT) return res.status(400).json({ error: `Keep it under ${MAX_INPUT.toLocaleString()} characters.` });

  const ticket = cleanTicket(body.ticket);
  const { text: input, redactions } = redact(raw);
  const facts = parse(input);
  const model = PRICES[process.env.CLAUDE_MODEL] ? process.env.CLAUDE_MODEL : DEFAULT_MODEL;
  const user = userMessage({ input, facts, ticket });
  const reserve = maxCost(model, SYSTEM.length + JSON.stringify(SCHEMA).length + user.length, MAX_TOKENS);

  let gate;
  try {
    gate = await begin(code, reserve, ticket?.id);
  } catch (err) {
    console.error(err);
    return res.status(503).json({ error: 'The demo’s access service is unavailable right now.' });
  }
  if (!gate?.ok) {
    const r = REASONS[gate?.reason] || REASONS.disabled;
    return res.status(r.status).json({ error: r.message, reason: gate?.reason });
  }

  const started = Date.now();
  try {
    const { data, usage, model: used } = await callClaude({ model, system: SYSTEM, user, schema: SCHEMA, maxTokens: MAX_TOKENS });
    const cost = actualCost(model, usage);
    await finish(gate.request_id, true, cost, usage, used).catch((e) => console.error(e));
    const after = await checkCode(code).catch(() => null);
    data.docs = data.docs.map((d) => ({ ...d, title: DOCS.find((x) => x.url === d.url)?.title || d.url }));
    return res.status(200).json({
      facts, redactions, result: data, model: used,
      cost_usd: Number(cost.toFixed(4)),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      remaining_usd: after?.remaining_usd ?? null,
    });
  } catch (err) {
    console.error(err);
    // Settle to what was really spent: real usage if Claude answered, the reservation if we can't tell, 0 if it never ran.
    const cost = err.usage ? actualCost(model, err.usage) : err.reachedClaude === 'unknown' ? reserve : 0;
    await finish(gate.request_id, false, cost, err.usage || {}, model).catch((e) => console.error(e));
    return res.status(502).json({ error: `Couldn’t get an explanation: ${err.message}.` });
  }
}

function cleanTicket(t) {
  if (!t || typeof t !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const id = s(t.id, 40).replace(/[^\w-]/g, '');
  return id ? { id, subject: s(t.subject, 200), plan: s(t.plan, 40) } : null;
}
