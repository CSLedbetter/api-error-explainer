// Everything is rendered with textContent, so nothing pasted or returned can inject markup.
const $ = (id) => document.getElementById(id);
const KEY = 'aee-code';
const state = { code: null, ticket: null, tickets: [], last: null };

const store = {
  get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* private mode */ } },
};

const money = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);

// ---------- access ----------
async function unlock(code, quiet = false) {
  $('access-error').hidden = true;
  try {
    const res = await fetch('/api/session', { method: 'POST', headers: { 'x-access-code': code } });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'That code didn’t work.');
    state.code = code;
    store.set(code);
    $('who').textContent = body.label;
    $('left').textContent = `${money(body.remaining_usd)} of budget left`;
    $('code-form').hidden = true;
    $('signed-in').hidden = false;
  } catch (err) {
    store.set(null);
    if (!quiet) showAccessError(err.message);
  }
  updateButton();
}

function showAccessError(msg) {
  $('access-error').textContent = msg;
  $('access-error').hidden = false;
}

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim().toLowerCase();
  if (!/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code)) return showAccessError('Codes look like 1a2b-3c4d-5e6f-7a8b.');
  unlock(code);
});

$('sign-out').addEventListener('click', () => {
  state.code = null;
  store.set(null);
  $('signed-in').hidden = true;
  $('code-form').hidden = false;
  $('code').value = '';
  updateButton();
});

// ---------- tickets ----------
function ticketButton(t, onPick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ticket';
  b.setAttribute('aria-pressed', 'false');
  for (const [cls, text] of [['t-id', `${t.id}${t.plan ? ` · ${t.plan}` : ''}`], ['t-sub', t.subject], ['t-who', [t.from_name, t.company].filter(Boolean).join(', ')]]) {
    if (!text) continue;
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    b.append(s);
  }
  b.addEventListener('click', () => {
    document.querySelectorAll('.ticket').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    onPick(t);
  });
  return b;
}

function loadTicket(t) {
  state.ticket = t;
  $('input').value = t.body;
  $('ticket-chip').textContent = `${t.id}: ${t.subject}${t.source ? ` (from ${t.source})` : ''}`;
  $('ticket-chip').hidden = false;
  countChars();
  if (window.matchMedia('(max-width: 860px)').matches) $('input').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadQueue() {
  try {
    state.tickets = await (await fetch('/tickets.json')).json();
  } catch { state.tickets = []; }
  const ul = $('tickets');
  for (const t of state.tickets) {
    const li = document.createElement('li');
    li.append(ticketButton(t, loadTicket));
    ul.append(li);
  }
}

// A ticket handed over by Doc Gap Finder arrives in the URL fragment, which never reaches the server.
function readHandoff() {
  const m = location.hash.match(/^#ticket=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const t = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const ticket = { id: s(t.id, 40), subject: s(t.subject, 200), body: s(t.body, 8000), plan: s(t.plan, 40), from_name: s(t.from_name, 80), source: 'Doc Gap Finder' };
    return ticket.id && ticket.body ? ticket : null;
  } catch { return null; }
}

function showHandoff(t) {
  const slot = $('handoff-slot');
  const label = document.createElement('p');
  label.className = 'handoff-label';
  label.textContent = 'Handed off from Doc Gap Finder';
  const ul = document.createElement('ul');
  ul.className = 'handoff';
  const li = document.createElement('li');
  const btn = ticketButton(t, loadTicket);
  li.append(btn);
  ul.append(li);
  slot.append(label, ul);
  btn.click();
}

// ---------- explain ----------
function countChars() {
  $('count').textContent = `${$('input').value.length.toLocaleString()} / 8,000`;
  updateButton();
}
function updateButton() {
  $('explain').disabled = !state.code || $('input').value.trim().length < 10;
  $('explain').title = state.code ? '' : 'Enter an access code first';
}
$('input').addEventListener('input', () => {
  if (state.ticket && $('input').value !== state.ticket.body) { state.ticket = null; $('ticket-chip').hidden = true; }
  countChars();
});
$('clear').addEventListener('click', () => {
  $('input').value = '';
  state.ticket = null;
  $('ticket-chip').hidden = true;
  document.querySelectorAll('.ticket').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  countChars();
  $('input').focus();
});

$('explain').addEventListener('click', async () => {
  const out = $('result');
  out.hidden = false;
  out.className = 'panel result loading';
  out.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Reading the error and checking it against the docs…' }));
  $('explain').disabled = true;
  try {
    const t = state.ticket;
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-access-code': state.code },
      body: JSON.stringify({ input: $('input').value, ticket: t ? { id: t.id, subject: t.subject, plan: t.plan } : null }),
    });
    const body = await res.json().catch(() => ({ error: 'The server sent back something unexpected.' }));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    render(body);
    if (body.remaining_usd != null) $('left').textContent = `${money(body.remaining_usd)} of budget left`;
  } catch (err) {
    out.className = 'panel result';
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = err.message;
    out.replaceChildren(p);
  } finally {
    updateButton();
  }
});

function render(data) {
  state.last = data;
  const r = data.result;
  const out = $('result');
  out.className = 'panel result';
  out.replaceChildren($('tpl-result').content.cloneNode(true));
  const f = (name) => out.querySelector(`[data-f="${name}"]`);
  const list = (el, items) => el.replaceChildren(...items.map((x) => Object.assign(document.createElement('li'), { textContent: x })));

  f('headline').textContent = r.headline;
  const side = { customer: 'Fix is on the customer’s side', anthropic: 'Platform side, not the customer', both: 'Both sides have a part', unclear: 'Side unclear' }[r.whose_side];
  const badges = [[side, r.whose_side], [`${r.confidence} confidence`, '']];
  if (r.escalate_to_engineering) badges.push(['Escalate', 'esc']);
  if (data.facts.spend_cap) badges.push(['Spend cap, not a rate limit', 'customer']);
  f('badges').replaceChildren(...badges.map(([text, cls]) => Object.assign(document.createElement('span'), { className: `badge ${cls}`, textContent: text })));

  const facts = data.facts;
  const rows = [
    ['HTTP status', facts.http_status], ['Error type', facts.error_type], ['Error code', facts.error_code],
    ['Request ID', facts.request_id], ['Retry-after', facts.retry_after_seconds != null ? `${facts.retry_after_seconds} s` : null],
    ['Message', facts.message], ['Rate-limit headers', facts.ratelimit_headers?.join('\n')],
  ].filter(([, v]) => v != null && v !== '');
  if (!rows.length) rows.push(['Nothing structured', 'No status, error type, or request ID found in the text.']);
  if (data.redactions) rows.push(['Removed', `${data.redactions} API key${data.redactions > 1 ? 's' : ''} before sending`]);
  f('facts').replaceChildren(...rows.flatMap(([k, v]) => [
    Object.assign(document.createElement('dt'), { textContent: k }),
    Object.assign(document.createElement('dd'), { textContent: String(v) }),
  ]));

  f('cause').textContent = r.likely_cause;
  f('retry').textContent = r.retry_guidance;
  list(f('evidence'), r.evidence);
  list(f('steps'), r.fix_steps);
  if (r.questions_for_customer.length) list(f('questions'), r.questions_for_customer);
  else f('questions-wrap').remove();
  f('docs').replaceChildren(...r.docs.map((d) => {
    const li = document.createElement('li');
    const a = Object.assign(document.createElement('a'), { href: d.url, textContent: d.title, target: '_blank', rel: 'noopener' });
    li.append(a, Object.assign(document.createElement('span'), { textContent: d.why }));
    return li;
  }));
  f('admin').textContent = r.admin_reply;
  f('exec').textContent = r.exec_summary;
  if (r.escalate_to_engineering) { f('escalate').hidden = false; f('escalation').textContent = r.escalation_note; }
  f('meta').textContent = `${data.model} · ${data.seconds} s · this run cost $${data.cost_usd.toFixed(4)}`;

  out.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
    const text = b.dataset.copy === 'admin' ? r.admin_reply : r.exec_summary;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1800);
  }));
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- start ----------
(async function start() {
  await loadQueue();
  const handoff = readHandoff();
  if (handoff) showHandoff(handoff);
  const saved = store.get();
  if (saved) unlock(saved, true);
  countChars();
})();
