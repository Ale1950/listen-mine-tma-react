/**
 * ═══ Bee SDK Service ═══
 *
 * Real integration with @teamgosh/bee-sdk following the official
 * miner-react example from gosh-sh/bee-engine.
 *
 * Flow:
 *   1. init() → load WASM
 *   2. gen_mining_keys(APP_ID) → returns {deep_link, public, secret}
 *   3. show deep_link to user (button or QR) → user opens AN Wallet
 *   4. user confirms registration in AN Wallet
 *   5. get_miner_address_by_wallet_name({wallet_name}) → resolves miner address
 *   6. ensure_mining_keys_propagated(...) → polls until on-chain confirmation
 *   7. Miner.new(...) → creates miner instance
 *   8. miner.start(duration_ms, callback) → start mining session
 *   9. miner.add_tap(x, y) → add tap (we trigger on Last.fm track changes)
 *  10. miner.get_reward() → claim rewards
 *  11. miner.stop() → stop mining
 *
 * NOTE: At time of writing, @teamgosh/bee-sdk 0.1.0 has a known
 * "MessageFilter" GraphQL schema bug that prevents taps from reaching
 * the chain. Local computation works (tap_computed events fire).
 * Eugene needs to publish 0.1.1 with the fix.
 *
 * Once 0.1.1 is published, npm update will activate real mining
 * without any code changes here.
 */

import init, {
  gen_mining_keys,
  ensure_mining_keys_propagated,
  get_miner_address_by_wallet_name,
  Miner,
} from '@teamgosh/bee-sdk';

// Public APP_ID workaround until we deploy our own Dapp ID
// Per the docs, this is the value to use during integration
export const APP_ID = '0x0000000000000000000000000000000000000000000000000000000000000001';

export const ENDPOINTS = ['https://mainnet.ackinacki.org'];

let wasmInitialized = false;
let currentMiner: Miner | null = null;

// ═══ Initialize WASM (call once) ═══
export async function initBeeSDK(): Promise<void> {
  if (wasmInitialized) return;
  await init({ module_or_path: '/listen-mine-tma-react/bee_sdk_bg.wasm' });
  wasmInitialized = true;
}

// ═══ Step 1: Generate mining keys ═══
// Returns { deep_link, public, secret }
// The deep_link is what we show to the user (as button or QR)
export async function generateMiningKeys() {
  if (!wasmInitialized) await initBeeSDK();
  const result = await gen_mining_keys(APP_ID);
  return {
    deepLink: result.deep_link,
    publicKey: result.public,
    secretKey: result.secret,
  };
}

// ═══ Step 2: Resolve wallet name to miner address ═══
export async function resolveMinerAddress(walletName: string): Promise<string> {
  if (!wasmInitialized) await initBeeSDK();
  return await get_miner_address_by_wallet_name({
    client_config: { network: { endpoints: ENDPOINTS } },
    wallet_name: walletName,
  });
}

// ═══ Step 3: Wait for user authorization ═══
// Polls the chain until the public key appears in the user's Miner contract
// Throws if max_attempts is reached without confirmation
export async function waitForAuthorization(
  minerAddress: string,
  expectedPublic: string,
  maxAttempts = 60,
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

// ═══ Step 4: Create miner instance ═══
export async function createMiner(
  minerAddress: string,
  publicKey: string,
  secretKey: string
): Promise<Miner> {
  if (!wasmInitialized) await initBeeSDK();
  // Free previous instance if any
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

// ═══ Mining session control ═══
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
// Once the user authorizes, we save the keys so we don't have to
// re-authorize on every session. The secret stays in localStorage
// (browser-only — never sent to a server).
const STORAGE_KEY = 'lm_mining_keys_v1';

export interface StoredMiningKeys {
  walletName: string;
  minerAddress: string;
  publicKey: string;
  secretKey: string;
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
