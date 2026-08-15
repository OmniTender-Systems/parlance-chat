import * as libsignalNs from '@privacyresearch/libsignal-protocol-typescript';
import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  type SignalProtocolAddressType,
} from '@privacyresearch/libsignal-protocol-typescript';
import { LocalSignalStore } from './store';
import { api } from '../api';

// The package's default export initializes its WASM/asm.js curve25519
// backend; under some ESM/CJS interop setups (Vite dev vs. build) the
// default binding doesn't come through cleanly, so resolve it defensively.
async function libsignal() {
  // Vite's CJS/ESM interop can wrap the module namespace an extra layer
  // (`ns.default` resolving back to the namespace itself instead of the
  // package's init function) depending on dev vs. build mode, so walk down
  // `.default` until we find something callable.
  let candidate: any = libsignalNs;
  for (let i = 0; i < 5 && typeof candidate !== 'function'; i++) {
    if (!candidate || candidate.default === candidate) break;
    candidate = candidate.default;
  }
  if (typeof candidate !== 'function') {
    throw new Error('could not resolve libsignal-protocol-typescript default init function');
  }
  return candidate();
}

// One SignalProtocolAddress per remote user (deviceId fixed at 1 — no
// multi-device support in this MVP, see README limitations).
function address(userId: string): SignalProtocolAddressType {
  return {
    name: userId,
    deviceId: 1,
    toString: () => `${userId}.1`,
    equals: (o) => o.name === userId && o.deviceId === 1,
  };
}
// SessionCipher accepts a plain "name.deviceId" string and builds its own
// SignalProtocolAddress internally.
function addressString(userId: string): string {
  return `${userId}.1`;
}

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(str: string): ArrayBuffer {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)).buffer;
}
function utf8ToBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}
function bufToUtf8(b: ArrayBuffer): string {
  return new TextDecoder().decode(b);
}

let cachedStore: LocalSignalStore | null = null;
function getStore(userId: string) {
  if (!cachedStore) cachedStore = new LocalSignalStore(userId);
  return cachedStore;
}

// Called once after register/login: generate an X3DH key bundle (identity
// key, signed prekey, a batch of one-time prekeys) and publish the PUBLIC
// halves to the server so other users can start a session with us.
export async function ensureKeysPublished(userId: string) {
  await libsignal(); // initializes the WASM/JS crypto backend
  const store = getStore(userId);
  const alreadyDone = localStorage.getItem(`parlance:${userId}:bundlePublished`);
  if (alreadyDone) return;

  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  await store.setIdentityKeyPair(identityKeyPair);
  await store.setLocalRegistrationId(registrationId);

  const signedPreKeyId = 1;
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
  await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair);

  const oneTimePrekeys = [];
  for (let i = 1; i <= 10; i++) {
    const pk = await KeyHelper.generatePreKey(i);
    await store.storePreKey(i, pk.keyPair);
    oneTimePrekeys.push({ keyId: i, pubkey: b64(pk.keyPair.pubKey) });
  }

  await api.publishBundle({
    registrationId,
    identityPubkey: b64(identityKeyPair.pubKey),
    signedPrekeyId: signedPreKeyId,
    signedPrekeyPub: b64(signedPreKey.keyPair.pubKey),
    signedPrekeySig: b64(signedPreKey.signature),
    oneTimePrekeys,
  });

  localStorage.setItem(`parlance:${userId}:bundlePublished`, '1');
}

async function ensureSession(userId: string, remoteUserId: string, remoteUsername: string) {
  const store = getStore(userId);
  const addr = address(remoteUserId);
  const cipher = new SessionCipher(store, addressString(remoteUserId));
  if (await cipher.hasOpenSession()) return;

  // X3DH: fetch the remote user's published bundle and process it as initiator.
  const bundle = await api.getBundle(remoteUsername);
  const builder = new SessionBuilder(store, addr);
  await builder.processPreKey({
    identityKey: unb64(bundle.identityPubkey),
    signedPreKey: {
      keyId: bundle.signedPrekeyId,
      publicKey: unb64(bundle.signedPrekeyPub),
      signature: unb64(bundle.signedPrekeySig),
    },
    preKey: bundle.oneTimePrekey
      ? { keyId: bundle.oneTimePrekey.keyId, publicKey: unb64(bundle.oneTimePrekey.pubkey) }
      : undefined,
    registrationId: bundle.registrationId,
  });
}

// Encrypts `plaintext` for a single recipient (Double Ratchet is pairwise —
// group messages are fanned out client-side, one ciphertext per member).
export async function encryptFor(
  userId: string,
  recipientId: string,
  recipientUsername: string,
  plaintext: string
): Promise<{ type: number; body: string }> {
  await libsignal();
  await ensureSession(userId, recipientId, recipientUsername);
  const store = getStore(userId);
  const cipher = new SessionCipher(store, addressString(recipientId));
  const result = await cipher.encrypt(utf8ToBuf(plaintext));
  // result.body is a "binary string" (one char per byte) per the library's
  // internal wire format; btoa() already expects exactly that shape.
  const bodyStr = result.body as unknown as string;
  return { type: result.type, body: btoa(bodyStr) };
}

// Decrypts a ciphertext blob that was addressed to us, sent by `senderId`.
export async function decryptFrom(
  userId: string,
  senderId: string,
  cipherType: number,
  ciphertextB64: string
): Promise<string> {
  await libsignal();
  const store = getStore(userId);
  const cipher = new SessionCipher(store, addressString(senderId));
  const binaryStr = atob(ciphertextB64); // reverse of btoa() done at encrypt time
  const plaintext =
    cipherType === 3 // PreKeyWhisperMessage
      ? await cipher.decryptPreKeyWhisperMessage(binaryStr, 'binary')
      : await cipher.decryptWhisperMessage(binaryStr, 'binary');
  return bufToUtf8(plaintext);
}
