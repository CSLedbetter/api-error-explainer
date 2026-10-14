// Owner page: the server checks the signed-in email against ADMIN_EMAIL on every call.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
let data = null;

async function call(method, body) {
  const res = await fetch('/api/admin', {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${window.DemoAuth.token()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

async function load() {
  $('admin-error').hidden = true;
  try {
    data = await call('GET');
    render();
  } catch (err) {
    $('admin-error').textContent = err.message;
    $('admin-error').hidden = false;
  }
}

function render() {
  const pending = data.users.filter((u) => u.status === 'pending').length;
  $('totals').textContent = `$${Number(data.spent_total_usd).toFixed(2)} of $${Number(data.settings.global_cap_usd).toFixed(0)} spent · ${data.users.length} people · ${pending} waiting`;
  $('toggle').textContent = data.settings.enabled ? 'Turn live demo off' : 'Turn live demo on';
  $('people').replaceChildren(...data.users.map(row));
  if (!data.users.length) $('people').append(Object.assign(el('tr'), { innerHTML: '<td colspan="6" class="muted">No one has signed in yet.</td>' }));
}

function row(u) {
  const tr = el('tr', { className: u.status });
  const who = el('td');
  who.append(el('b', { textContent: u.full_name || '(no name)' }), el('br'),
    el('a', { href: `mailto:${u.email}`, textContent: u.email }));
  const status = el('td');
  status.append(el('span', { className: `badge ${u.status}`, textContent: u.status }), el('span', { className: 'muted small', textContent: ` via ${u.provider || '?'}` }));
  const seen = el('td', { className: 'small' });
  seen.append(el('span', { textContent: `First: ${when(u.requested_at)}` }), el('br'), el('span', { className: 'muted', textContent: `Last: ${when(u.last_seen_at)}` }));
  const use = el('td', { className: 'small' });
  use.append(el('span', { textContent: `${u.requests} calls` }), el('br'),
    el('span', { className: 'muted', textContent: `${u.explainer_requests} API · ${u.sso_requests} SSO · ${u.vendor_requests ?? 0} vendor` }));
  const budget = el('td', { className: 'small' });
  const cap = el('select');
  cap.setAttribute('aria-label', `Budget for ${u.email}`);
  for (const v of [1, 2, 5, 10, 15]) cap.append(el('option', { value: v, textContent: `$${v} cap`, selected: Number(u.cap_usd) === v }));
  if (![1, 2, 5, 10, 15].includes(Number(u.cap_usd))) cap.prepend(el('option', { value: u.cap_usd, textContent: `$${u.cap_usd} cap`, selected: true }));
  cap.addEventListener('change', () => act(u, u.status, Number(cap.value)));
  budget.append(el('span', { textContent: `$${Number(u.spent_usd).toFixed(2)} spent` }), el('br'), cap);
  const actions = el('td', { className: 'row-actions' });
  if (u.status !== 'approved') actions.append(button('Approve', () => act(u, 'approved')));
  if (u.status !== 'revoked') actions.append(button(u.status === 'pending' ? 'Decline' : 'Revoke', () => act(u, 'revoked'), 'link'));
  tr.append(who, status, seen, use, budget, actions);
  return tr;
}

function button(text, fn, cls = '') {
  const b = el('button', { type: 'button', className: cls, textContent: text });
  b.addEventListener('click', async () => { b.disabled = true; await fn(); });
  return b;
}

async function act(u, status, cap) {
  try { await call('POST', { action: 'set', user_id: u.user_id, status, cap_usd: cap }); } catch (err) { alertBox(err.message); }
  load();
}
function alertBox(msg) { $('admin-error').textContent = msg; $('admin-error').hidden = false; }

$('reload').addEventListener('click', load);
$('toggle').addEventListener('click', async () => {
  try { await call('POST', { action: 'toggle', enabled: !data.settings.enabled }); } catch (err) { alertBox(err.message); }
  load();
});

window.DemoAuth.onChange((auth) => {
  const isAdmin = Boolean(auth.status?.is_admin);
  $('admin').hidden = !isAdmin;
  if (isAdmin) load();
  else if (auth.status && auth.status.status !== 'signed_out') alertBox('This page is only for the site owner.');
});
