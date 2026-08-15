# Parlance Chat

An open-source, end-to-end-encrypted chat app — a minimal, standalone
alternative to Signal/Telegram, **not** a multi-network bridge like Beeper.
This is an MVP scaffold: a working demo of registration, real-time
messaging, and E2E encryption, built to be extended, not a production
Signal replacement.

## Architecture

Monorepo, two packages:

- **`/server`** — Node.js + TypeScript + Express + Socket.io. REST endpoints
  for auth (username/password + bcrypt + JWT) and for publishing/fetching
  Signal-protocol key bundles. Socket.io handles real-time message delivery,
  typing indicators, and presence. Persistence is SQLite via
  `better-sqlite3` (schema: `users`, `identity_keys`, `one_time_prekeys`,
  `conversations`, `conversation_members`, `messages`).
- **`/client`** — React + Vite. Login/register, conversation list, chat
  window, group-chat creation. All Signal-protocol crypto (session state,
  private keys) runs in the browser and is persisted to `localStorage`,
  namespaced per user — **private key material never leaves the client**.

## Encryption: what we used and why

The server **only ever stores and relays ciphertext**. Message bodies are
end-to-end encrypted using the Signal protocol (X3DH key agreement +
Double Ratchet per-conversation session state).

The task called for `libsignal` (`github.com/signalapp/libsignal`), Signal's
official Rust/multi-language library. We checked its current license: it is
**AGPL-3.0** (`LICENSE` in that repo, verified directly, not assumed). Two
factors made pulling libsignal itself impractical for a fast MVP: (1) its
public API surface is oriented around Signal's own multi-device/PNI account
model rather than a bare X3DH+Double Ratchet primitive, and (2) it ships as
native Rust with WASM/Node bindings that add a nontrivial build/toolchain
dependency for a scaffold meant to run with a plain `npm install`.

Instead we used **[`@privacyresearch/libsignal-protocol-typescript`](https://www.npmjs.com/package/@privacyresearch/libsignal-protocol-typescript)**,
a well-known, actively-referenced TypeScript reimplementation of the same
X3DH + Double Ratchet protocol (a maintained descendant of the original
`libsignal-protocol-javascript` used by Signal's own early web/desktop
clients). It gives us the same cryptographic design in a pure-JS package
that runs directly in the browser with no native build step — a pragmatic
stand-in, not the official implementation.

**License implications — read this before you build on top of this repo.**
This project vendors AGPL-3.0-influenced protocol code and, more importantly,
we are choosing to license **this entire project AGPL-3.0** to stay
consistent with the spirit of the crypto libraries in this space and the
task's instruction. AGPL-3.0 means: if you run a modified version of this
server (even just over a network, without distributing binaries — e.g. as a
hosted chat service), **you must make your complete corresponding source
available to users of that service.** This is stricter than the regular GPL.
If you plan to build a closed/hosted product on this codebase, get your own
legal review before doing so.

## What's implemented

- Username/password registration & login (bcrypt + JWT, no phone
  verification — out of scope for MVP).
- X3DH key bundle publish/fetch (`identity_keys`, `one_time_prekeys`
  tables) so any two users can bootstrap an encrypted session without ever
  having talked before.
- Per-recipient Double Ratchet encryption. Group chats **fan out
  client-side**: each group message is encrypted once per member and
  stored/delivered as N separate ciphertext rows/envelopes (Double Ratchet
  is inherently pairwise — there is no group-ratchet/sender-key optimization
  here, unlike real Signal groups).
- Real-time delivery + typing + presence over Socket.io, scoped to
  conversation rooms.
- SQLite persistence; the `messages` table stores only `ciphertext` +
  `cipher_type` — verified empirically (see Verification below).

## What's explicitly NOT implemented (be honest about scope)

- **No push notifications** (client must be connected/open to receive
  live messages; history is fetched on load).
- **No mobile clients** (web only).
- **No multi-device key sync.** Each browser/profile is its own Signal
  "device" (`deviceId` hardcoded to 1) with its own identity key. Logging
  into the same account in a second browser will not share encrypted
  history with the first — a real deployment needs Signal's
  multi-device/linked-device protocol.
- **No safety-number / identity-verification UI.** Trust-on-first-use
  (TOFU): the client accepts a peer's identity key the first time it sees
  one and never re-prompts if it changes. This is a real MITM-resistance
  gap versus production Signal.
- No voice/video calls, no read receipts beyond basic presence, no message
  editing/deletion/reactions, no file/media attachments.
- No rate limiting, no account recovery/password reset flow, no admin
  tooling.
- `oneTimePrekeys` are not automatically replenished server-side once
  consumed — a long-lived deployment would need a "request more prekeys"
  endpoint the client polls.

## Setup

Requires Node.js 18+.

```bash
# 1. Server
cd server
cp .env.example .env   # edit JWT_SECRET for anything beyond local testing
npm install
npm run dev             # http://localhost:4000

# 2. Client (separate terminal)
cd client
cp .env.example .env
npm install
npm run dev              # http://localhost:5173
```

Open two browser windows (or one normal + one incognito, so `localStorage`
— and therefore each simulated "device" — is separate), register two
different usernames, start a chat, and send messages.

## Verifying the server never sees plaintext

With the server running against `server/parlance.db`:

```bash
sqlite3 server/parlance.db "SELECT id, sender_id, recipient_id, cipher_type, ciphertext FROM messages;"
```

You'll see `ciphertext` as opaque base64 blobs — the plaintext you typed in
the browser is never sent to or stored by the server.

## Project layout

```
parlance-chat/
├── server/          Express + Socket.io + SQLite backend
│   └── src/
│       ├── db.ts        schema + connection
│       ├── auth.ts       JWT signing/verification middleware
│       ├── routes.ts     REST: auth, key bundles, conversations, messages
│       └── index.ts      Socket.io wiring + app bootstrap
├── client/          React + Vite frontend
│   └── src/
│       ├── crypto/
│       │   ├── store.ts   localStorage-backed Signal protocol store
│       │   └── signal.ts  X3DH bootstrap + encrypt/decrypt helpers
│       ├── api.ts         REST client
│       ├── socket.ts      Socket.io client
│       ├── AuthContext.tsx
│       ├── LoginPage.tsx
│       └── ChatPage.tsx
└── README.md (this file)
```

## License

AGPL-3.0. See [What's implemented / license implications](#encryption-what-we-used-and-why)
above.
