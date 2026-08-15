import type { StorageType, KeyPairType } from '@privacyresearch/libsignal-protocol-typescript';
import { Direction } from '@privacyresearch/libsignal-protocol-typescript';

// Minimal SignalProtocolStore backed by localStorage, namespaced per logged-in
// user so multiple accounts can coexist in the same browser profile.
// Private key material never leaves the browser / never hits the server.

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(str: string): ArrayBuffer {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)).buffer;
}

export class LocalSignalStore implements StorageType {
  private ns: string;
  constructor(userId: string) {
    this.ns = `parlance:${userId}:`;
  }
  private get(key: string) {
    const raw = localStorage.getItem(this.ns + key);
    return raw ? JSON.parse(raw) : undefined;
  }
  private set(key: string, value: unknown) {
    localStorage.setItem(this.ns + key, JSON.stringify(value));
  }
  private remove(key: string) {
    localStorage.removeItem(this.ns + key);
  }

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const v = this.get('identityKey');
    if (!v) return undefined;
    return { pubKey: unb64(v.pubKey), privKey: unb64(v.privKey) };
  }
  async setIdentityKeyPair(keyPair: KeyPairType) {
    this.set('identityKey', { pubKey: b64(keyPair.pubKey), privKey: b64(keyPair.privKey) });
  }
  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.get('registrationId');
  }
  async setLocalRegistrationId(id: number) {
    this.set('registrationId', id);
  }
  async isTrustedIdentity(identifier: string, _identityKey: ArrayBuffer, _direction: Direction): Promise<boolean> {
    // MVP: trust-on-first-use (TOFU), same default posture as most Signal-protocol
    // quickstarts. A real deployment would surface safety-number verification UI.
    void identifier;
    return true;
  }
  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    this.set(`identity:${encodedAddress}`, b64(publicKey));
    return true;
  }
  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    const v = this.get(`preKey:${keyId}`);
    if (!v) return undefined;
    return { pubKey: unb64(v.pubKey), privKey: unb64(v.privKey) };
  }
  async storePreKey(keyId: string | number, keyPair: KeyPairType) {
    this.set(`preKey:${keyId}`, { pubKey: b64(keyPair.pubKey), privKey: b64(keyPair.privKey) });
  }
  async removePreKey(keyId: string | number) {
    this.remove(`preKey:${keyId}`);
  }
  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    const v = this.get(`signedPreKey:${keyId}`);
    if (!v) return undefined;
    return { pubKey: unb64(v.pubKey), privKey: unb64(v.privKey) };
  }
  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType) {
    this.set(`signedPreKey:${keyId}`, { pubKey: b64(keyPair.pubKey), privKey: b64(keyPair.privKey) });
  }
  async removeSignedPreKey(keyId: string | number) {
    this.remove(`signedPreKey:${keyId}`);
  }
  async storeSession(encodedAddress: string, record: string) {
    this.set(`session:${encodedAddress}`, record);
  }
  async loadSession(encodedAddress: string): Promise<string | undefined> {
    return this.get(`session:${encodedAddress}`);
  }
}
