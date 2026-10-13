import { getUser, isAdmin, adminList, adminSet, adminToggle } from '../lib/gate.js';

// Casey's approval page. Only the signed-in admin (ADMIN_EMAIL) gets past the first check.
export default async function handler(req, res) {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    if (!isAdmin(user)) return res.status(403).json({ error: 'This page is only for the site owner.' });

    if (req.method === 'GET') return res.status(200).json(await adminList());
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET or POST.' });

    const b = typeof req.body === 'object' && req.body ? req.body : {};
    if (b.action === 'set') {
      if (!/^[0-9a-f-]{36}$/i.test(b.user_id || '') || !['approved', 'revoked', 'pending'].includes(b.status)) {
        return res.status(400).json({ error: 'Bad request.' });
      }
      const cap = b.cap_usd == null ? null : Number(b.cap_usd);
      if (cap != null && !(cap >= 0 && cap <= 15)) return res.status(400).json({ error: 'Cap must be between $0 and $15.' });
      return res.status(200).json(await adminSet(b.user_id, b.status, cap));
    }
    if (b.action === 'toggle') return res.status(200).json({ enabled: await adminToggle(Boolean(b.enabled)) });
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error(err);
    return res.status(503).json({ error: 'The access service is unavailable right now.' });
  }
}
