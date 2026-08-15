// Double Ratchet message keys are single-use: once a ciphertext is
// decrypted, decrypting it again fails ("message key not found"). Since
// this MVP has no server-side plaintext, the client must remember what it
// has already decrypted (locally, never sent anywhere) so that receiving a
// message live and then re-fetching history after a reload don't both try
// to consume the same one-time key. Namespaced per logged-in user.
interface CachedMessage {
  senderId: string;
  senderName: string;
  text: string;
  createdAt: string;
}

function key(userId: string) {
  return `parlance:${userId}:plaintextCache`;
}

function readAll(userId: string): Record<string, CachedMessage> {
  const raw = localStorage.getItem(key(userId));
  return raw ? JSON.parse(raw) : {};
}

export function getCachedMessage(userId: string, messageId: string): CachedMessage | undefined {
  return readAll(userId)[messageId];
}

export function cacheMessage(userId: string, messageId: string, msg: CachedMessage) {
  const all = readAll(userId);
  all[messageId] = msg;
  localStorage.setItem(key(userId), JSON.stringify(all));
}
