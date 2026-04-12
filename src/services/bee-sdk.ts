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
  ensure_mining_keys_propagated,
  get_miner_address_by_wallet_name,
  Miner,
} from '@teamgosh/bee-sdk';

// ═══ APP_ID ═══
// Placeholder value per official Bee Engine SDK docs (Step 1, Application Registration).
// Will be replaced with our own Dapp ID once we deploy a root contract.
export const APP_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

// ═══ Endpoints ═══
// Format matches the official miner-react example: bare domain, no protocol prefix.
export const ENDPOINTS = ['mainnet-cf.ackinacki.org'];

// ═══ WASM path ═══
// Uses Vite's BASE_URL so it always matches vite.config.ts `base`.
// File is served from public/bee_sdk_bg.wasm
const WASM_PATH = `${import.meta.env.BASE_URL}bee_sdk_bg.wasm`;

let wasmInitialized = false;
let currentMiner: Miner | null = null;

// ═══ Initialize WASM (call once) ═══
export async function initBeeSDK(): Promise<void> {
  if (wasmInitialized) return;
  await init({ module_or_path: WASM_PATH });
  wasmInitialized = true;
}

// ═══ Step 2 — Generate mining keys ═══
export async function generateMiningKeys() {
  if (!wasmInitialized) await initBeeSDK();
  const result = await gen_mining_keys(APP_ID);
  return {
    deepLink: result.deep_link,
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
// Polls the Miner contract until expected_owner_public is registered.
// User must open deep_link in AN Wallet and confirm during this window.
export async function waitForAuthorization(
  minerAddress: string,
  expectedPublic: string,
  maxAttempts = 180,
  intervalMs = 2000
): Promise<void> {
  if (!wasmInitialized) await initBeeSDK();
  await ensure_mining_keys_propagated({
    client_config: { network: { endpoints: ENDPOINTS } },
    miner_address: minerAddress,
    app_id: APP_ID,
    expected_owner_public: expectedPublic,
    max_attempts: maxAttempts,
    interval_ms: intervalMs,
  });
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
