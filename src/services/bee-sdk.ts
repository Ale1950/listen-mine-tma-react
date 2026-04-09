/**
 * ═══ Bee SDK Service ═══
 *
 * Two modes:
 *
 * 1. FULL AUTH FLOW (for new users):
 *    init → gen_mining_keys → resolveMinerAddress → waitForAuthorization → createMiner
 *    Requires the user to confirm in AN Wallet. Currently "(in progress)" per docs —
 *    wallet does not show the auth dialog yet.
 *
 * 2. MANUAL KEYS (for users with existing mining keys from Batteries/Popits/etc):
 *    init → createMiner(pre-existing keys)
 *    Skips authorization entirely. Uses keys already registered on-chain by another
 *    official TMA (Batteries, Popits, Ludo). Works today.
 *
 * Keys can be extracted from any official TMA via F12 console trick (see INSTRUCTIONS).
 *
 * IMPORTANT: Each set of mining keys is tied to a specific APP_ID:
 *   - Popits → 0x...0001
 *   - Batteries → 0x...0002
 *   - Ludo → TBD
 * You MUST use the SAME app_id when calling Miner.new() as the one that registered
 * the keys, otherwise the contract won't find the public key and taps will fail.
 */

import init, {
  gen_mining_keys,
  ensure_mining_keys_propagated,
  get_miner_address_by_wallet_name,
  Miner,
} from '@teamgosh/bee-sdk';

// ═══ APP_IDs of known Acki Nacki TMAs ═══
export const APP_IDS = {
  popits: '0x0000000000000000000000000000000000000000000000000000000000000001',
  batteries: '0x0000000000000000000000000000000000000000000000000000000000000002',
  // Ludo: TBD (not yet extracted)
} as const;

export type AppIdKey = keyof typeof APP_IDS;

// Default for fresh gen_mining_keys flow
export const DEFAULT_APP_ID = APP_IDS.popits;

export const ENDPOINTS = ['https://mainnet.ackinacki.org'];

let wasmInitialized = false;
let currentMiner: Miner | null = null;
let currentAppId: string = DEFAULT_APP_ID;

// ═══ Initialize WASM (call once) ═══
export async function initBeeSDK(): Promise<void> {
  if (wasmInitialized) return;
  await init({ module_or_path: '/listen-mine-tma-react/bee_sdk_bg.wasm' });
  wasmInitialized = true;
}

// ═══ FULL AUTH FLOW — Step 1: Generate mining keys ═══
export async function generateMiningKeys(appId: string = DEFAULT_APP_ID) {
  if (!wasmInitialized) await initBeeSDK();
  const result = await gen_mining_keys(appId);
  return {
    deepLink: result.deep_link,
    publicKey: result.public,
    secretKey: result.secret,
  };
}

// ═══ FULL AUTH FLOW — Step 2: Resolve wallet name to miner address ═══
export async function resolveMinerAddress(walletName: string): Promise<string> {
  if (!wasmInitialized) await initBeeSDK();
  return await get_miner_address_by_wallet_name({
    client_config: { network: { endpoints: ENDPOINTS } },
    wallet_name: walletName,
  });
}

// ═══ FULL AUTH FLOW — Step 3: Wait for user authorization ═══
export async function waitForAuthorization(
  minerAddress: string,
  expectedPublic: string,
  appId: string = DEFAULT_APP_ID,
  maxAttempts = 180,
  intervalMs = 2000
): Promise<void> {
  if (!wasmInitialized) await initBeeSDK();
  await ensure_mining_keys_propagated({
    client_config: { network: { endpoints: ENDPOINTS } },
    miner_address: minerAddress,
    app_id: appId,
    expected_owner_public: expectedPublic,
    max_attempts: maxAttempts,
    interval_ms: intervalMs,
  });
}

// ═══ CREATE MINER — works for both modes ═══
// appId MUST match the one under which the keys were registered on-chain.
// For extracted keys from Batteries, use APP_IDS.batteries.
// For fresh keys from gen_mining_keys(), use the same appId you passed to it.
export async function createMiner(
  minerAddress: string,
  publicKey: string,
  secretKey: string,
  appId: string = DEFAULT_APP_ID
): Promise<Miner> {
  if (!wasmInitialized) await initBeeSDK();

  if (currentMiner) {
    try { currentMiner.free(); } catch {}
    currentMiner = null;
  }

  const miner = await Miner.new(ENDPOINTS, appId, minerAddress, publicKey, secretKey);
  currentMiner = miner;
  currentAppId = appId;
  return miner;
}

export function getCurrentMiner(): Miner | null {
  return currentMiner;
}

export function getCurrentAppId(): string {
  return currentAppId;
}

// ═══ Mining session control ═══
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

// ═══ Persistent storage of mining keys ═══
// The secret is stored in localStorage (browser-only, never sent to a server).
// Use clearMiningKeys() when done testing.
const STORAGE_KEY = 'lm_mining_keys_v2';

export interface StoredMiningKeys {
  walletName: string;
  walletAddress: string;  // The actual wallet address (where NACKL/SHELL/USDC live)
  minerAddress: string;   // The miner contract address (where tap work is tracked)
  publicKey: string;
  secretKey: string;
  appId: string;
  source: 'generated' | 'imported';
  authorizedAt: number;
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
