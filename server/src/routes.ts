import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { signToken, requireAuth, AuthedRequest } from './auth';

export const router = Router();

// --- Register ---
router.post('/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'username and password (min 6 chars) required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'username taken' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, hash);

  const token = signToken(id, username);
  res.json({ token, userId: id, username });
});

// --- Login ---
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signToken(user.id, user.username);
  res.json({ token, userId: user.id, username: user.username });
});

// --- Publish X3DH key bundle (identity key, signed prekey, one-time prekeys) ---
router.post('/keys/bundle', requireAuth, (req: AuthedRequest, res) => {
  const { registrationId, identityPubkey, signedPrekeyId, signedPrekeyPub, signedPrekeySig, oneTimePrekeys } = req.body || {};
  if (!registrationId || !identityPubkey || !signedPrekeyPub || !signedPrekeySig) {
    return res.status(400).json({ error: 'incomplete key bundle' });
  }
  db.prepare(`
    INSERT INTO identity_keys (user_id, registration_id, identity_pubkey, signed_prekey_id, signed_prekey_pub, signed_prekey_sig, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      registration_id = excluded.registration_id,
      identity_pubkey = excluded.identity_pubkey,
      signed_prekey_id = excluded.signed_prekey_id,
      signed_prekey_pub = excluded.signed_prekey_pub,
      signed_prekey_sig = excluded.signed_prekey_sig,
      updated_at = datetime('now')
  `).run(req.userId, registrationId, identityPubkey, signedPrekeyId, signedPrekeyPub, signedPrekeySig);

  if (Array.isArray(oneTimePrekeys)) {
    const insert = db.prepare('INSERT INTO one_time_prekeys (user_id, key_id, pubkey) VALUES (?, ?, ?)');
    const tx = db.transaction((keys: any[]) => {
      for (const k of keys) insert.run(req.userId, k.keyId, k.pubkey);
    });
    tx(oneTimePrekeys);
  }
  res.json({ ok: true });
});

// --- Fetch a user's key bundle to start a session (X3DH) ---
router.get('/keys/bundle/:username', requireAuth, (req: AuthedRequest, res) => {
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username) as any;
  if (!target) return res.status(404).json({ error: 'user not found' });

  const identity = db.prepare('SELECT * FROM identity_keys WHERE user_id = ?').get(target.id) as any;
  if (!identity) return res.status(404).json({ error: 'no key bundle published for user' });

  // consume one one-time prekey if available
  const otk = db.prepare('SELECT * FROM one_time_prekeys WHERE user_id = ? AND used = 0 LIMIT 1').get(target.id) as any;
  if (otk) db.prepare('UPDATE one_time_prekeys SET used = 1 WHERE id = ?').run(otk.id);

  res.json({
    userId: target.id,
    registrationId: identity.registration_id,
    identityPubkey: identity.identity_pubkey,
    signedPrekeyId: identity.signed_prekey_id,
    signedPrekeyPub: identity.signed_prekey_pub,
    signedPrekeySig: identity.signed_prekey_sig,
    oneTimePrekey: otk ? { keyId: otk.key_id, pubkey: otk.pubkey } : null,
  });
});

// --- Users list (for starting new conversations) ---
router.get('/users', requireAuth, (req: AuthedRequest, res) => {
  const rows = db.prepare('SELECT id, username FROM users WHERE id != ?').all(req.userId);
  res.json(rows);
});

// --- Conversations ---
router.get('/conversations', requireAuth, (req: AuthedRequest, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.is_group, c.name, c.created_at
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.userId) as any[];

  const withMembers = rows.map((c) => {
    const members = db.prepare(`
      SELECT u.id, u.username FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ?
    `).all(c.id);
    return { ...c, members };
  });
  res.json(withMembers);
});

router.post('/conversations', requireAuth, (req: AuthedRequest, res) => {
  const { memberUsernames, name, isGroup } = req.body || {};
  if (!Array.isArray(memberUsernames) || memberUsernames.length === 0) {
    return res.status(400).json({ error: 'memberUsernames required' });
  }
  const members = memberUsernames.map((u: string) =>
    db.prepare('SELECT id FROM users WHERE username = ?').get(u) as any
  );
  if (members.some((m: any) => !m)) return res.status(404).json({ error: 'one or more usernames not found' });

  const id = uuid();
  db.prepare('INSERT INTO conversations (id, is_group, name) VALUES (?, ?, ?)').run(
    id, isGroup ? 1 : 0, name || null
  );
  const insertMember = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
  insertMember.run(id, req.userId);
  for (const m of members) insertMember.run(id, m.id);

  res.json({ id });
});

// --- Message history (ciphertext only, delivered per-recipient) ---
router.get('/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
  const membership = db.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).get(req.params.id, req.userId);
  if (!membership) return res.status(403).json({ error: 'not a member' });

  const rows = db.prepare(`
    SELECT id, sender_id, recipient_id, cipher_type, ciphertext, created_at
    FROM messages
    WHERE conversation_id = ? AND (sender_id = ? OR recipient_id = ?)
    ORDER BY created_at ASC
  `).all(req.params.id, req.userId, req.userId);
  res.json(rows);
});
