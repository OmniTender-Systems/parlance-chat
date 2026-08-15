import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { api } from './api';
import { getSocket } from './socket';
import { decryptFrom, encryptFor } from './crypto/signal';
import { cacheMessage, getCachedMessage } from './crypto/plaintextCache';

interface Member {
  id: string;
  username: string;
}
interface Conversation {
  id: string;
  is_group: number;
  name: string | null;
  members: Member[];
}
interface DisplayMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

export function ChatPage() {
  const { auth, logout } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, DisplayMessage[]>>({});
  const [users, setUsers] = useState<Member[]>([]);
  const [draft, setDraft] = useState('');
  const [newChatUsernames, setNewChatUsernames] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeConvo = conversations.find((c) => c.id === activeId) || null;

  useEffect(() => {
    api.listConversations().then(setConversations).catch(console.error);
    api.listUsers().then(setUsers).catch(console.error);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !auth) return;

    async function onNew(envelope: any) {
      if (envelope.senderId === auth!.userId && envelope.recipientId !== auth!.userId) return;
      // only decrypt messages addressed to us (or our own outgoing echo, which
      // we already have plaintext for locally and skip re-decrypting)
      if (envelope.senderId === auth!.userId) return;
      const senderName = conversations
        .find((c) => c.id === envelope.conversationId)
        ?.members.find((m) => m.id === envelope.senderId)?.username || 'unknown';
      try {
        // a message key is single-use: if we already decrypted this message
        // (e.g. a duplicate delivery), reuse the cached plaintext instead of
        // decrypting again, which would throw.
        const cached = getCachedMessage(auth!.userId, envelope.id);
        const text = cached ? cached.text : await decryptFrom(auth!.userId, envelope.senderId, envelope.cipherType, envelope.ciphertext);
        if (!cached) cacheMessage(auth!.userId, envelope.id, { senderId: envelope.senderId, senderName, text, createdAt: envelope.createdAt });
        setMessages((prev) => ({
          ...prev,
          [envelope.conversationId]: [
            ...(prev[envelope.conversationId] || []),
            { id: envelope.id, senderId: envelope.senderId, senderName, text, createdAt: envelope.createdAt },
          ],
        }));
      } catch (err) {
        console.error('decrypt failed', err);
      }
    }

    socket.on('message:new', onNew);
    return () => {
      socket.off('message:new', onNew);
    };
  }, [auth, conversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeId]);

  async function openConversation(id: string) {
    setActiveId(id);
    getSocket()?.emit('join', id);
    if (!messages[id]) {
      // history comes back as ciphertext; we only render what we can decrypt
      // (messages we sent don't round-trip here since server stores per-recipient
      // rows, so for the MVP we just show what the server has for this user)
      const rows = await api.getMessages(id);
      const convo = conversations.find((c) => c.id === id);
      const decrypted: DisplayMessage[] = [];
      for (const row of rows) {
        const senderName = convo?.members.find((m) => m.id === row.sender_id)?.username || 'unknown';
        // We can't decrypt our own outgoing ciphertext (Double Ratchet is
        // one-directional per key) and don't currently correlate our
        // locally-generated draft id with the server's row id, so our own
        // sent messages don't survive a reload in this MVP (see README).
        if (row.sender_id === auth!.userId) continue;
        try {
          // reuse cached plaintext if we already decrypted this one live —
          // Double Ratchet message keys are single-use, so decrypting the
          // same ciphertext twice would throw.
          const cached = getCachedMessage(auth!.userId, row.id);
          const text = cached ? cached.text : await decryptFrom(auth!.userId, row.sender_id, row.cipher_type, row.ciphertext);
          if (!cached) cacheMessage(auth!.userId, row.id, { senderId: row.sender_id, senderName, text, createdAt: row.created_at });
          decrypted.push({ id: row.id, senderId: row.sender_id, senderName, text, createdAt: row.created_at });
        } catch (err) {
          console.error('history decrypt failed', err);
        }
      }
      setMessages((prev) => ({ ...prev, [id]: decrypted }));
    }
  }

  async function sendMessage() {
    if (!draft.trim() || !activeConvo || !auth) return;
    const text = draft;
    setDraft('');
    const others = activeConvo.members.filter((m) => m.id !== auth.userId);
    for (const recipient of others) {
      const { type, body } = await encryptFor(auth.userId, recipient.id, recipient.username, text);
      getSocket()?.emit('message:send', {
        conversationId: activeConvo.id,
        recipientId: recipient.id,
        cipherType: type,
        ciphertext: body,
      });
    }
    // show our own plaintext locally right away (server only ever stores ciphertext)
    setMessages((prev) => ({
      ...prev,
      [activeConvo.id]: [
        ...(prev[activeConvo.id] || []),
        { id: crypto.randomUUID(), senderId: auth.userId, senderName: auth.username, text, createdAt: new Date().toISOString() },
      ],
    }));
  }

  async function createConversation() {
    const usernames = newChatUsernames.split(',').map((s) => s.trim()).filter(Boolean);
    if (usernames.length === 0) return;
    const isGroup = usernames.length > 1;
    const { id } = await api.createConversation(usernames, isGroup, isGroup ? usernames.join(', ') : undefined);
    const convos = await api.listConversations();
    setConversations(convos);
    setNewChatUsernames('');
    openConversation(id);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <div style={{ width: 280, borderRight: '1px solid #ddd', padding: 12, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{auth?.username}</strong>
          <button onClick={logout} style={{ fontSize: 12 }}>log out</button>
        </div>
        <hr />
        <div style={{ marginBottom: 12 }}>
          <input
            placeholder="username(s), comma-separated"
            value={newChatUsernames}
            onChange={(e) => setNewChatUsernames(e.target.value)}
            style={{ width: '100%', padding: 6, marginBottom: 4 }}
          />
          <button onClick={createConversation} style={{ width: '100%' }}>Start chat</button>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            known users: {users.map((u) => u.username).join(', ') || 'none yet'}
          </div>
        </div>
        {conversations.map((c) => {
          const label = c.is_group
            ? c.name || 'group'
            : c.members.find((m) => m.id !== auth?.userId)?.username || '(empty)';
          return (
            <div
              key={c.id}
              onClick={() => openConversation(c.id)}
              style={{
                padding: 8,
                cursor: 'pointer',
                background: activeId === c.id ? '#eef' : 'transparent',
                borderRadius: 4,
              }}
            >
              {label}
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {activeConvo ? (
          <>
            <div style={{ padding: 12, borderBottom: '1px solid #ddd' }}>
              {activeConvo.is_group
                ? activeConvo.name || 'group'
                : activeConvo.members.find((m) => m.id !== auth?.userId)?.username}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {(messages[activeConvo.id] || []).map((m) => (
                <div key={m.id} style={{ marginBottom: 8, textAlign: m.senderId === auth?.userId ? 'right' : 'left' }}>
                  <div style={{ fontSize: 11, color: '#888' }}>{m.senderName}</div>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '6px 10px',
                      borderRadius: 12,
                      background: m.senderId === auth?.userId ? '#06c' : '#eee',
                      color: m.senderId === auth?.userId ? 'white' : 'black',
                    }}
                  >
                    {m.text}
                  </span>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <div style={{ display: 'flex', padding: 12, borderTop: '1px solid #ddd' }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="type a message..."
                style={{ flex: 1, padding: 8 }}
              />
              <button onClick={sendMessage} style={{ marginLeft: 8 }}>Send</button>
            </div>
          </>
        ) : (
          <div style={{ margin: 'auto', color: '#888' }}>Select or start a conversation</div>
        )}
      </div>
    </div>
  );
}
