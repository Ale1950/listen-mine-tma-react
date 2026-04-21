/**
 * ═══ Bee Engine SDK Service ═══
 *
 * Thin wrapper around @teamgosh/bee-sdk following the OFFICIAL integration flow
 * documented at:
 *   https://dev.ackinacki.com/bee-engine/bee-engine-sdk-integration-documentation
 *
 * Reference implementation:
 *   https://github.com/gosh-sh/bee-engine/blob/main/examples/javascript/miner-react/src/App.tsx
 *
 * Mandatory 5-step flow (the ONLY supported path in this project):
 *   1. init(WASM)
 *   2. gen_mining_keys(APP_ID)        → { deep_link, public, secret }
 *   3. get_miner_address_by_wallet_name({ client_config, wallet_name })
 *   4. user opens deep_link in AN Wallet and confirms
 *   5. ensure_mining_keys_propagated(...) polls until on-chain confirmation
 *   6. Miner.new(endpoints, app_id, miner_address, public, secret)
 *   7. Miner API: can_start / start(duration_ms, cb) / add_tap(x,y) / stop / get_reward
 *
 * IMPORTANT: any pattern that bypasses user authorization via AN Wallet
 * (e.g. External call to acceptTap with sole mining keys, or re-using keys
 * extracted from another TMA) is DEPRECATED and produces no reward.
 * It is not supported here.
 */

import init, {
  gen_mining_keys,
  get_miner_address_by_wallet_name,
  Miner,
} from '@teamgosh/bee-sdk';
import { sha256 } from 'js-sha256';

// ═══ Resilient WebSocket wrapper ═══
// Replaces globalThis.WebSocket so any WebSocket opened by the Bee SDK (GQL
// subscriptions, session coordination) auto-reconnects on drops. Mirrors the
// pattern in Mining Hub 1.2.2: without it, a transient network hiccup during
// a session kills submit_session_root and the taps are lost.
let wsPatched = false;

function installResilientWs() {
  if (wsPatched) return;
  if (typeof globalThis === 'undefined' || typeof globalThis.WebSocket === 'undefined') return;
  const Native = globalThis.WebSocket;
  const RECONNECT_BASE = 1_000;
  const RECONNECT_MAX = 15_000;
  const MAX_RETRIES = 10;

  class ResilientWS extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    _url: string;
    _protocols?: string | string[];
    _ws: WebSocket | null = null;
    _sendQueue: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
    _retries = 0;
    _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    _closedByUser = false;

    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;

    binaryType: BinaryType = 'blob';

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      this._url = typeof url === 'string' ? url : url.toString();
      this._protocols = protocols;
      this._connect();
    }

    get readyState(): number {
      return this._ws ? this._ws.readyState : ResilientWS.CONNECTING;
    }
    get url(): string { return this._url; }
    get protocol(): string { return this._ws?.protocol ?? ''; }
    get bufferedAmount(): number { return this._ws?.bufferedAmount ?? 0; }
    get extensions(): string { return this._ws?.extensions ?? ''; }

    _dispatch(type: string, ev: Event) {
      // Forward to .on* handler
      const on = (this as any)[`on${type}`];
      if (typeof on === 'function') {
        try { on.call(this, ev); } catch (e) { console.error('[ResilientWS] handler error:', e); }
      }
      // Forward to addEventListener() listeners
      try { this.dispatchEvent(ev); } catch {}
    }

    _connect() {
      try {
        this._ws = new Native(this._url, this._protocols as any);
        this._ws.binaryType = this.binaryType;
      } catch (e) {
        console.warn('[ResilientWS] construct failed:', e);
        this._scheduleReconnect();
        return;
      }

      this._ws.addEventListener('open', (ev) => {
        this._retries = 0;
        // Flush queued sends
        const q = this._sendQueue.splice(0);
        for (const m of q) {
          try { this._ws!.send(m); } catch (e) { console.warn('[ResilientWS] flush send failed:', e); }
        }
        this._dispatch('open', new Event('open'));
        void ev;
      });

      this._ws.addEventListener('message', (ev) => {
        const me = new MessageEvent('message', {
          data: ev.data,
          origin: ev.origin,
          lastEventId: ev.lastEventId,
        });
        this._dispatch('message', me);
      });

      this._ws.addEventListener('error', () => {
        this._dispatch('error', new Event('error'));
      });

      this._ws.addEventListener('close', (ev) => {
        if (this._closedByUser || ev.code === 1000 || this._retries >= MAX_RETRIES) {
          const ce = new CloseEvent('close', {
            code: ev.code, reason: ev.reason, wasClean: ev.wasClean,
          });
          this._dispatch('close', ce);
          return;
        }
        this._scheduleReconnect();
      });
    }

    _scheduleReconnect() {
      if (this._reconnectTimer !== null) return;
      this._retries++;
      const delay = Math.min(RECONNECT_BASE * Math.pow(2, this._retries - 1), RECONNECT_MAX);
      console.log(`[ResilientWS] reconnect #${this._retries} in ${delay}ms → ${this._url}`);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._connect();
      }, delay);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this._ws && this._ws.readyState === ResilientWS.OPEN) {
        this._ws.send(data);
      } else {
        this._sendQueue.push(data);
      }
    }

    close(code?: number, reason?: string) {
      this._closedByUser = true;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      try { this._ws?.close(code, reason); } catch {}
    }
  }

  (globalThis as any).WebSocket = ResilientWS;
  wsPatched = true;
  console.log('[ResilientWS] installed — WebSocket replaced with auto-reconnect wrapper');
}

// ═══ APP_ID ═══
// Canonical AN mainnet APP_ID used by Popit Game and all official TMAs
// (Ludo, Batteries, Popits). Confirmed by Eugene (GOSH) as the value to use
// until we deploy our own Dapp ID root contract. The all-zeros variant in the
// miner-react skeleton example is not the production value.
export const APP_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// ═══ Endpoints ═══
// Reverted to https://mainnet-cf.ackinacki.org — bare hostname (matching the
// official miner-react example) breaks get_miner_address_by_wallet_name with
// KitError code 205 "Failed to fetch". Our WASM build expects the protocol
// in the endpoint string.
export const ENDPOINTS = ['https://mainnet-cf.ackinacki.org'];

// ═══ WASM path ═══
// Uses Vite's BASE_URL so it always matches vite.config.ts `base`.
// File is served from public/bee_sdk_bg.wasm
const WASM_PATH = `${import.meta.env.BASE_URL}bee_sdk_bg.wasm`;

let wasmInitialized = false;
let currentMiner: Miner | null = null;

// ═══ Initialize WASM (call once) ═══
export async function initBeeSDK(): Promise<void> {
  if (wasmInitialized) return;
  // Patch WebSocket before SDK spins up any internal connections.
  installResilientWs();
  await init({ module_or_path: WASM_PATH });
  wasmInitialized = true;
}

// ═══ Deep-link builder for AN Wallet ═══
// The npm @teamgosh/bee-sdk@0.1.0 returns the OLD deep_link format
// (/wallet/connect, unsigned). AN Wallet requires the NEW format
// (/deeplinks/wallet/set-mining-keys, HMAC-SHA256 signed).
// Per Eugene (GOSH), we keep the SDK's gen_mining_keys() for the key pair
// and build the deep link by hand. Without a valid signature, AN Wallet
// opens but silently rejects — no user-visible error.
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function hmacSha256Hex(secretBytes: Uint8Array, message: string): Promise<string> {
  // Prefer Web Crypto (HTTPS / secure context). Fallback to js-sha256 otherwise.
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const key = await crypto.subtle.importKey(
      'raw', secretBytes as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign(
      'HMAC', key,
      new TextEncoder().encode(message) as BufferSource
    );
    return bytesToHex(new Uint8Array(sig));
  }
  return sha256.hmac(secretBytes, message);
}

export async function buildSetMiningKeysDeepLink(
  publicKey: string,
  secretKey: string,
  walletName: string
): Promise<string> {
  // 1. Inner payload
  const inner = JSON.stringify({
    app_id: APP_ID,
    public: publicKey,
    user_id: crypto.randomUUID(),
    username: walletName,
  });
  const innerB64 = utf8ToBase64(inner);

  // 2. HMAC-SHA256 over innerB64 using secret key bytes
  const secretBytes = hexToBytes(secretKey);
  const signature = await hmacSha256Hex(secretBytes, innerB64);

  // 3. Outer envelope. expire_at is Unix timestamp in SECONDS (not ms).
  const outer = JSON.stringify({
    data: innerB64,
    expire_at: Math.floor(Date.now() / 1000) + 3600,
    signature,
  });
  const outerB64 = utf8ToBase64(outer);

  return `https://links.gosh.sh/deeplinks/wallet/set-mining-keys?payload=${outerB64}`;
}

// ═══ Step 2 — Generate mining keys + signed deep link ═══
export async function generateMiningKeys(walletName: string) {
  if (!wasmInitialized) await initBeeSDK();
  const result = await gen_mining_keys(APP_ID);
  const deepLink = await buildSetMiningKeysDeepLink(
    result.public,
    result.secret,
    walletName
  );
  return {
    deepLink,
    publicKey: result.public,
    secretKey: result.secret,
  };
}

// ═══ Step 3 — Resolve wallet name to miner contract address ═══
export async function resolveMinerAddress(walletName: string): Promise<string> {
  if (!wasmInitialized) await initBeeSDK();
  return await get_miner_address_by_wallet_name({
    client_config: { network: { endpoints: ENDPOINTS } },
    wallet_name: walletName,
  });
}

// ═══ Step 5 — Wait for user authorization to propagate on-chain ═══
// Polls the Miner contract account via REST until we detect a new transaction
// (i.e., the set-mining-keys tx landed). Replaces the SDK's
// ensure_mining_keys_propagated which is broken in @teamgosh/bee-sdk@0.1.0
// (its subscription query uses a GraphQL "MessageFilter" type that the current
// mainnet schema no longer accepts → every poll returns a schema error).
// REST /v2/account CORS is correctly configured on both mainnet + mainnet-cf.
const REST_ENDPOINTS = [
  'https://mainnet-cf.ackinacki.org',
  'https://mainnet.ackinacki.org',
];

async function fetchAccountSnapshot(minerAddress: string): Promise<string | null> {
  const addr = encodeURIComponent(minerAddress);
  for (const base of REST_ENDPOINTS) {
    try {
      const res = await fetch(`${base}/v2/account?address=${addr}`);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text) continue;
      // Normalize away any per-response server timestamps/proxy fields by
      // extracting the most stable per-chain marker we can find. If none of
      // the known LT-style fields exist, fall back to the raw body.
      try {
        const parsed = JSON.parse(text);
        const marker =
          parsed?.last_trans_lt ??
          parsed?.lastTransLt ??
          parsed?.last_paid ??
          parsed?.lastPaid ??
          parsed?.data ??
          parsed?.boc ??
          parsed?.hash ??
          null;
        if (marker !== null && marker !== undefined) return String(marker);
      } catch {
        /* non-JSON — fall through to raw body */
      }
      return text;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

export async function waitForAuthorization(
  minerAddress: string,
  _expectedPublic: string,
  maxAttempts = 180,
  intervalMs = 2000
): Promise<void> {
  const initial = await fetchAccountSnapshot(minerAddress);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const current = await fetchAccountSnapshot(minerAddress);
    if (current !== null && initial !== null && current !== initial) {
      // Account state changed after we generated keys → wallet submitted a tx.
      // Small grace period so subsequent reads see the final state.
      await new Promise((r) => setTimeout(r, intervalMs));
      return;
    }
  }
  throw new Error(
    'waitForAuthorization: timeout — no on-chain activity detected on miner address'
  );
}

// ═══ Step 6 — Create Miner instance ═══
export async function createMiner(
  minerAddress: string,
  publicKey: string,
  secretKey: string
): Promise<Miner> {
  if (!wasmInitialized) await initBeeSDK();

  if (currentMiner) {
    try { currentMiner.free(); } catch {}
    currentMiner = null;
  }

  const miner = await Miner.new(ENDPOINTS, APP_ID, minerAddress, publicKey, secretKey);
  currentMiner = miner;
  return miner;
}

export function getCurrentMiner(): Miner | null {
  return currentMiner;
}

// ═══ Step 7 — Mining session control (Bee Engine Miner API) ═══
export function canStartMining(): boolean {
  if (!currentMiner) return false;
  try {
    return currentMiner.can_start();
  } catch {
    return false;
  }
}

export function startMiningSession(
  durationMs: number,
  callback: (event: any) => void
): boolean {
  if (!currentMiner) return false;
  if (!currentMiner.can_start()) return false;
  currentMiner.start(durationMs, callback);
  return true;
}

export function addTap(x: number, y: number): boolean {
  if (!currentMiner) return false;
  try {
    currentMiner.add_tap(x, y);
    return true;
  } catch {
    return false;
  }
}

export function stopMining(): void {
  if (!currentMiner) return;
  try {
    currentMiner.stop();
  } catch {}
}

export async function claimReward(): Promise<boolean> {
  if (!currentMiner) return false;
  try {
    await currentMiner.get_reward();
    return true;
  } catch {
    return false;
  }
}

export async function getMinerData() {
  if (!currentMiner) return null;
  try {
    return await currentMiner.get_miner_data();
  } catch {
    return null;
  }
}

// ═══ Persistent storage of authorized mining keys ═══
// Keys are stored in localStorage (browser-only, never sent to a server).
// Call clearMiningKeys() to disconnect.
const STORAGE_KEY = 'lm_mining_keys_v2';

export interface StoredMiningKeys {
  walletName: string;
  minerAddress: string;  // Miner contract address (tracks tap work)
  publicKey: string;
  secretKey: string;
  appId: string;
  authorizedAt: number;  // Timestamp of on-chain propagation confirmation
}

export function saveMiningKeys(keys: StoredMiningKeys): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function loadMiningKeys(): StoredMiningKeys | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearMiningKeys(): void {
  localStorage.removeItem(STORAGE_KEY);
}
