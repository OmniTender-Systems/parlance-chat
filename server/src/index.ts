import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { router } from './routes';
import { verifySocketToken } from './auth';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', router);
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// userId -> set of connected socket ids (multi-tab presence)
const online = new Map<string, Set<string>>();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  const identity = verifySocketToken(token);
  if (!identity) return next(new Error('unauthorized'));
  (socket as any).userId = identity.userId;
  (socket as any).username = identity.username;
  next();
});

io.on('connection', (socket) => {
  const userId = (socket as any).userId as string;
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId)!.add(socket.id);
  io.emit('presence', { userId, online: true });

  // join a room per conversation the user belongs to
  const convos = db.prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?').all(userId) as any[];
  for (const c of convos) socket.join(c.conversation_id);

  socket.on('join', (conversationId: string) => {
    const membership = db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(conversationId, userId);
    if (membership) socket.join(conversationId);
  });

  // client sends one ciphertext blob PER RECIPIENT (Double Ratchet is pairwise,
  // so group messages fan out client-side into N encrypted envelopes).
  socket.on('message:send', (payload: {
    conversationId: string;
    recipientId: string;
    cipherType: number;
    ciphertext: string;
    clientMsgId?: string;
  }) => {
    const membership = db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(payload.conversationId, userId);
    if (!membership) return;

    const id = uuid();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, recipient_id, cipher_type, ciphertext)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, payload.conversationId, userId, payload.recipientId, payload.cipherType, payload.ciphertext);

    const envelope = {
      id,
      conversationId: payload.conversationId,
      senderId: userId,
      recipientId: payload.recipientId,
      cipherType: payload.cipherType,
      ciphertext: payload.ciphertext,
      createdAt: new Date().toISOString(),
      clientMsgId: payload.clientMsgId,
    };

    // deliver only to the intended recipient's sockets + echo to sender's other tabs
    const recipientSockets = online.get(payload.recipientId);
    if (recipientSockets) for (const sid of recipientSockets) io.to(sid).emit('message:new', envelope);
    const senderSockets = online.get(userId);
    if (senderSockets) for (const sid of senderSockets) io.to(sid).emit('message:new', envelope);
  });

  socket.on('typing', (data: { conversationId: string }) => {
    socket.to(data.conversationId).emit('typing', { userId, conversationId: data.conversationId });
  });

  socket.on('disconnect', () => {
    const set = online.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(userId);
        io.emit('presence', { userId, online: false });
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`parlance-server listening on :${PORT}`));
