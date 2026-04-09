import { useState, useEffect, useRef } from 'react';
import {
  getWalletBalance,
  getDebugAccountInfo,
  discoverLinkedAccounts,
  sumLockedNackl,
  explorerAccountUrl,
  type WalletBalance,
  type DebugAccountInfo,
  type LinkedAccount,
} from './services/blockchain';
import { TrackMonitor, validateUser, type LastFmTrack } from './services/lastfm';
import {
  initBeeSDK,
  generateMiningKeys,
  resolveMinerAddress,
  waitForAuthorization,
  createMiner,
  startMiningSession,
  stopMining,
  addTap,
  getMinerData,
  saveMiningKeys,
  loadMiningKeys,
  clearMiningKeys,
  APP_IDS,
  type StoredMiningKeys,
} from './services/bee-sdk';
import { detectLang, isRTL, t, type Lang } from './services/i18n';

type AuthState = 'idle' | 'generating' | 'awaiting' | 'propagating' | 'ready' | 'error';

const SESSION_DURATION_MS = 330_000; // 5.5 min, same as official miners
const TAP_INTERVAL_MS = 4710; // 70 taps per session at 4.710s (matches api_miner.mjs)

export default function App() {
  // ═══ Language ═══
  const [lang] = useState<Lang>(detectLang());

  // ═══ Wallet ═══
  const [walletNameInput, setWalletNameInput] = useState(
    () => localStorage.getItem('lm_wallet_name') || ''
  );
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);

  // ═══ Last.fm ═══
  const [lastfmInput, setLastfmInput] = useState('');
  const [lastfmUser, setLastfmUser] = useState(
    () => localStorage.getItem('lm_lastfm_user') || ''
  );
  const [currentTrack, setCurrentTrack] = useState<LastFmTrack | null>(null);
  const trackMonitorRef = useRef<TrackMonitor | null>(null);

  // ═══ Mining auto-tap loop (fires every TAP_INTERVAL_MS while session active) ═══
  const tapTimerRef = useRef<number | null>(null);
  const sessionTimerRef = useRef<number | null>(null);
  const tapCoordsRef = useRef({ x: 200, y: 200 });
  const tapsCountRef = useRef(0);
  // Screen Wake Lock — prevents iOS/Android from putting the page to sleep
  // which throttles setInterval and kills the tap loop mid-session.
  const wakeLockRef = useRef<any>(null);

  // ═══ Mining auth ═══
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [authError, setAuthError] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [storedKeys, setStoredKeys] = useState<StoredMiningKeys | null>(
    () => loadMiningKeys()
  );

  // ═══ Import keys form (JSON paste mode) ═══
  const [showImportForm, setShowImportForm] = useState(false);
  const [importMode, setImportMode] = useState<'json' | 'manual'>('json');
  const [importJson, setImportJson] = useState('');
  const [importWalletAddr, setImportWalletAddr] = useState('');
  const [importMinerAddr, setImportMinerAddr] = useState('');
  const [importPublic, setImportPublic] = useState('');
  const [importSecret, setImportSecret] = useState('');
  const [importAppId, setImportAppId] = useState<string>(APP_IDS.popits);

  // ═══ Debug panel ═══
  const [showDebug, setShowDebug] = useState(false);
  const [debugMinerInfo, setDebugMinerInfo] = useState<DebugAccountInfo | null>(null);
  const [debugWalletInfo, setDebugWalletInfo] = useState<DebugAccountInfo | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  // ═══ Miner contract state (tapSum, commitTaps, pending rewards, etc) ═══
  // Read via bee-sdk.getMinerData() which returns the full contract account data.
  // We re-read it every 30s while mining is active to track accumulated work.
  const [minerData, setMinerData] = useState<any>(null);
  const [minerDataLoading, setMinerDataLoading] = useState(false);
  const [minerDataAt, setMinerDataAt] = useState<number | null>(null);

  // ═══ NACKL LOCKED — discovered via linked accounts ═══
  // The wallet shows only FREE NACKL. Mining rewards accumulate as LOCKED
  // NACKL inside the Mamaboard contract (one per app). We discover all
  // contracts the wallet has sent messages to and sum their NACKL balances.
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[] | null>(null);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedAt, setLinkedAt] = useState<number | null>(null);
  const lockedNackl = linkedAccounts ? sumLockedNackl(linkedAccounts) : null;

  // ═══ Mining session ═══
  const [miningActive, setMiningActive] = useState(false);
  const [tapsCount, setTapsCount] = useState(0);
  const [sessionStart, setSessionStart] = useState<number | null>(null);

  // ═══ Logs ═══
  const [logs, setLogs] = useState<string[]>([]);

  function addLog(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [`[${ts}] ${msg}`, ...prev.slice(0, 99)]);
  }

  // ═══ Init Bee SDK on mount ═══
  useEffect(() => {
    initBeeSDK()
      .then(() => addLog('Bee SDK loaded'))
      .catch(e => addLog(`Bee SDK init error: ${e.message}`));
  }, []);

  // ═══ Set HTML dir for RTL ═══
  useEffect(() => {
    document.documentElement.dir = isRTL(lang) ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  // ═══ Load wallet balance on mount if we have a stored wallet ═══
  useEffect(() => {
    if (storedKeys) {
      const addrForBalance = storedKeys.walletAddress || storedKeys.minerAddress;
      refreshBalance(addrForBalance);
    }
  }, []);

  // ═══ Last.fm track monitor ═══
  // Track changes are now just for the "now playing" display.
  // Taps are fired by an independent timer (see handleStartMining).
  useEffect(() => {
    if (!lastfmUser) return;
    addLog(`Monitoring Last.fm: ${lastfmUser}`);
    const monitor = new TrackMonitor(lastfmUser, (track) => {
      setCurrentTrack(track);
      addLog(`♪ ${track.artist} — ${track.title}`);
    });
    monitor.start(15000);
    trackMonitorRef.current = monitor;
    return () => {
      monitor.stop();
      trackMonitorRef.current = null;
    };
  }, [lastfmUser]);

  // ═══ Wallet balance refresh ═══
  async function refreshBalance(address: string) {
    setWalletLoading(true);
    try {
      const bal = await getWalletBalance(address);
      setWalletBalance(bal);
      if (bal.found) addLog(`Balance loaded from ${bal.network}`);
      else addLog(`Wallet not found: ${bal.error}`);
    } catch (e: any) {
      addLog(`Balance error: ${e.message}`);
    } finally {
      setWalletLoading(false);
    }
  }

  // ═══ Linked accounts discovery & locked NACKL ═══
  // Calls discoverLinkedAccounts() which:
  //  1. Queries the wallet's outbound internal messages (IntOut)
  //  2. Extracts unique destination addresses (these are the contracts the wallet interacts with)
  //  3. Batch-fetches balance_other for each
  //  4. Sums NACKL (currency 1) across all of them → this is "LOCKED NACKL"
  // The top result by NACKL balance is typically the Mamaboard.
  async function refreshLinkedAccounts(walletAddr?: string) {
    const addr = walletAddr || storedKeys?.walletAddress;
    if (!addr) return;
    setLinkedLoading(true);
    addLog('🔍 Discovering linked accounts…');
    try {
      const accounts = await discoverLinkedAccounts(addr);
      setLinkedAccounts(accounts);
      setLinkedAt(Date.now());
      const total = sumLockedNackl(accounts);
      addLog(`✓ Found ${accounts.length} linked accounts, total NACKL locked: ${total.toFixed(4)}`);
    } catch (e: any) {
      addLog(`✗ Linked accounts discovery failed: ${e.message}`);
    } finally {
      setLinkedLoading(false);
    }
  }

  // ═══ Miner contract data refresh ═══
  // Calls bee-sdk.getMinerData() which reads the full contract state:
  // _tapSum, _modifiedTapSum, _commitTaps, _miningDurSum, _seed, _epochStart, etc.
  async function refreshMinerData() {
    setMinerDataLoading(true);
    try {
      const data = await getMinerData();
      setMinerData(data);
      setMinerDataAt(Date.now());
      if (data) {
        addLog('✓ Miner stats refreshed');
      } else {
        addLog('✗ getMinerData returned null');
      }
    } catch (e: any) {
      addLog(`Miner stats error: ${e.message}`);
    } finally {
      setMinerDataLoading(false);
    }
  }

  // Auto-refresh miner stats every 30s while mining is active
  useEffect(() => {
    if (!miningActive) return;
    const id = window.setInterval(() => {
      refreshMinerData();
    }, 30000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miningActive]);

  // ═══ Handlers ═══
  async function handleSetLastfm() {
    if (!lastfmInput.trim()) return;
    addLog(`Validating Last.fm: ${lastfmInput}`);
    const valid = await validateUser(lastfmInput);
    if (!valid) {
      addLog('Last.fm user not found');
      return;
    }
    setLastfmUser(lastfmInput);
    localStorage.setItem('lm_lastfm_user', lastfmInput);
    addLog('✓ Last.fm connected');
  }

  function handleDisconnectLastfm() {
    trackMonitorRef.current?.stop();
    setLastfmUser('');
    setLastfmInput('');
    setCurrentTrack(null);
    localStorage.removeItem('lm_lastfm_user');
  }

  async function handleAuthorizeMining() {
    const name = walletNameInput.trim();
    if (!name) {
      addLog('Enter wallet name first');
      return;
    }
    localStorage.setItem('lm_wallet_name', name);

    setAuthState('generating');
    setAuthError('');
    addLog('Generating mining keys…');

    try {
      // Step 1: generate mining keys (uses DEFAULT_APP_ID = popits)
      const keys = await generateMiningKeys();
      addLog(`Mining keys generated. Public: ${keys.publicKey.substring(0, 16)}…`);

      // Step 2: resolve miner address from wallet name
      addLog(`Resolving miner address for "${name}"…`);
      const minerAddress = await resolveMinerAddress(name);
      addLog(`Miner address: ${minerAddress.substring(0, 24)}…`);

      // Step 3: show deep_link to user
      setDeepLink(keys.deepLink);
      setAuthState('awaiting');
      addLog('Open AN Wallet via the button below to confirm');

      // Step 4: poll for propagation
      setAuthState('propagating');
      addLog('Waiting for on-chain confirmation…');
      await waitForAuthorization(minerAddress, keys.publicKey, APP_IDS.popits, 180, 2000);
      addLog('✓ Mining keys propagated on-chain');

      // Step 5: create miner instance
      await createMiner(minerAddress, keys.publicKey, keys.secretKey, APP_IDS.popits);
      addLog('✓ Miner instance ready');

      // Save keys for next sessions
      // NOTE: In the full auth flow we don't have the actual wallet address,
      // only the miner contract address. We use minerAddress as a fallback for
      // balance queries (will show 0 NACKL because miner contracts don't hold tokens).
      // Users should use the JSON import path which includes wallet_address.
      const stored: StoredMiningKeys = {
        walletName: name,
        walletAddress: minerAddress,
        minerAddress,
        publicKey: keys.publicKey,
        secretKey: keys.secretKey,
        appId: APP_IDS.popits,
        source: 'generated',
        authorizedAt: Date.now(),
      };
      saveMiningKeys(stored);
      setStoredKeys(stored);
      setAuthState('ready');
      setDeepLink('');

      // Refresh balance and miner stats
      refreshBalance(minerAddress);
      refreshMinerData();
    } catch (e: any) {
      setAuthState('error');
      setAuthError(e.message || 'Unknown error');
      addLog(`✗ Auth failed: ${e.message}`);
    }
  }

  // ═══ IMPORT KEYS MODE — bypass the full auth flow ═══
  // ═══ IMPORT KEYS MODE — bypass the full auth flow ═══
  // Two input modes:
  //   'json'   → paste F12 console output (full JSON)
  //   'manual' → fill in each field by hand
  async function handleImportKeys() {
    const name = walletNameInput.trim() || 'imported_wallet';
    const appId = importAppId;

    let walletAddr = '';
    let minerAddr = '';
    let pub = '';
    let sec = '';

    if (importMode === 'json') {
      const rawJson = importJson.trim();
      if (!rawJson) {
        addLog('✗ Paste the JSON from the F12 console first');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(rawJson);
      } catch (e: any) {
        addLog(`✗ Invalid JSON: ${e.message}`);
        return;
      }
      walletAddr = String(parsed?.wallet_address || '').trim();
      minerAddr = String(parsed?.miner_address || '').trim();
      pub = String(parsed?.keys?.public || '').trim();
      sec = String(parsed?.keys?.secret || '').trim();
    } else {
      walletAddr = importWalletAddr.trim();
      minerAddr = importMinerAddr.trim();
      pub = importPublic.trim();
      sec = importSecret.trim();
    }

    const missing: string[] = [];
    if (!walletAddr) missing.push('wallet_address');
    if (!minerAddr) missing.push('miner_address');
    if (!pub) missing.push('public');
    if (!sec) missing.push('secret');
    if (missing.length > 0) {
      addLog(`✗ Missing fields: ${missing.join(', ')}`);
      return;
    }

    if (!minerAddr.startsWith('0:') || !walletAddr.startsWith('0:')) {
      addLog('✗ Addresses must start with 0:');
      return;
    }

    localStorage.setItem('lm_wallet_name', name);
    setAuthState('generating');
    addLog(`Importing keys (APP_ID=${appId.substring(0, 10)}…${appId.substring(appId.length - 4)})`);
    addLog(`Wallet: ${walletAddr.substring(0, 14)}…${walletAddr.substring(walletAddr.length - 6)}`);
    addLog(`Miner:  ${minerAddr.substring(0, 14)}…${minerAddr.substring(minerAddr.length - 6)}`);

    try {
      await createMiner(minerAddr, pub, sec, appId);
      addLog('✓ Miner instance created with imported keys');

      const stored: StoredMiningKeys = {
        walletName: name,
        walletAddress: walletAddr,
        minerAddress: minerAddr,
        publicKey: pub,
        secretKey: sec,
        appId,
        source: 'imported',
        authorizedAt: Date.now(),
      };
      saveMiningKeys(stored);
      setStoredKeys(stored);
      setAuthState('ready');
      setShowImportForm(false);
      setImportJson('');
      setImportWalletAddr('');
      setImportMinerAddr('');
      setImportPublic('');
      setImportSecret('');

      refreshBalance(walletAddr);
      refreshMinerData();
      refreshLinkedAccounts(walletAddr);
    } catch (e: any) {
      setAuthState('error');
      setAuthError(e.message || 'Unknown error');
      addLog(`✗ Import failed: ${e.message}`);
    }
  }

  async function handleResumeFromStored() {
    if (!storedKeys) return;
    addLog(`Resuming with stored keys (${storedKeys.source})…`);
    try {
      await createMiner(
        storedKeys.minerAddress,
        storedKeys.publicKey,
        storedKeys.secretKey,
        storedKeys.appId
      );
      setAuthState('ready');
      addLog('✓ Miner restored');
      const addrForBalance = storedKeys.walletAddress || storedKeys.minerAddress;
      refreshBalance(addrForBalance);
      refreshMinerData();
      refreshLinkedAccounts(addrForBalance);
    } catch (e: any) {
      addLog(`Restore failed: ${e.message}`);
      clearMiningKeys();
      setStoredKeys(null);
    }
  }

  // Auto-resume on mount if we have stored keys
  useEffect(() => {
    if (storedKeys && authState === 'idle') {
      handleResumeFromStored();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleStartMining() {
    addLog('Starting mining session…');
    const ok = startMiningSession(SESSION_DURATION_MS, (event) => {
      const action = event?.action || event;
      addLog(`📡 ${action}`);
    });
    if (!ok) {
      addLog('✗ Cannot start mining (miner not ready)');
      return;
    }
    setMiningActive(true);
    setSessionStart(Date.now());
    setTapsCount(0);
    tapsCountRef.current = 0;
    addLog(`✓ Session started (${SESSION_DURATION_MS / 1000}s, tap every ${TAP_INTERVAL_MS / 1000}s)`);

    // Request Screen Wake Lock to prevent iOS/Android from throttling timers
    // when the screen dims. Gracefully skipped if API is unavailable.
    (async () => {
      try {
        const nav: any = navigator;
        if (nav.wakeLock && typeof nav.wakeLock.request === 'function') {
          wakeLockRef.current = await nav.wakeLock.request('screen');
          addLog('🔒 Screen wake lock acquired (screen will stay on)');
          wakeLockRef.current.addEventListener?.('release', () => {
            addLog('⚠️ Wake lock released by system');
          });
        } else {
          addLog('⚠️ Wake Lock API unavailable — keep the TMA in foreground');
        }
      } catch (e: any) {
        addLog(`⚠️ Wake lock failed: ${e.message || 'unknown'}`);
      }
    })();

    // Reset coordinate drift starting point
    tapCoordsRef.current = {
      x: 100 + Math.floor(Math.random() * 200),
      y: 100 + Math.floor(Math.random() * 300),
    };

    // Start auto-tap loop — one tap every TAP_INTERVAL_MS (4.710s)
    // This matches the official api_miner.mjs script behavior (70 taps / session)
    tapTimerRef.current = window.setInterval(() => {
      // Random-walk drift: small movement each tap for varied coordinates
      // (from WASM analysis: modifiedTapSum rewards varied coords over fixed ones)
      const c = tapCoordsRef.current;
      c.x = Math.max(20, Math.min(280, c.x + (Math.random() - 0.5) * 30));
      c.y = Math.max(20, Math.min(380, c.y + (Math.random() - 0.5) * 30));
      const x = Math.floor(c.x);
      const y = Math.floor(c.y);

      if (addTap(x, y)) {
        tapsCountRef.current += 1;
        const n = tapsCountRef.current;
        setTapsCount(n);
        addLog(`👆 Tap #${n} (${x},${y})`);
      } else {
        addLog(`✗ Tap failed (${x},${y})`);
      }
    }, TAP_INTERVAL_MS);

    // Auto-stop when session duration expires
    sessionTimerRef.current = window.setTimeout(() => {
      addLog('⏰ Session duration expired, auto-stopping');
      handleStopMining();
    }, SESSION_DURATION_MS);
  }

  function handleStopMining() {
    // Clear tap timer
    if (tapTimerRef.current !== null) {
      window.clearInterval(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    // Clear session auto-stop timer
    if (sessionTimerRef.current !== null) {
      window.clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
    // Release wake lock
    if (wakeLockRef.current) {
      try {
        wakeLockRef.current.release?.();
      } catch {}
      wakeLockRef.current = null;
    }
    stopMining();
    setMiningActive(false);
    addLog(`Session stopped. Total taps: ${tapsCountRef.current}`);
  }

  // Re-acquire wake lock when the TMA comes back to foreground mid-session
  // (iOS/Android auto-release it when the page loses visibility).
  useEffect(() => {
    if (!miningActive) return;
    const handleVisibility = async () => {
      if (document.visibilityState === 'visible' && miningActive && !wakeLockRef.current) {
        try {
          const nav: any = navigator;
          if (nav.wakeLock?.request) {
            wakeLockRef.current = await nav.wakeLock.request('screen');
            addLog('🔒 Wake lock re-acquired after returning to foreground');
          }
        } catch {}
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [miningActive]);

  // ═══ Debug runner — fetches on-chain state for wallet + miner ═══
  async function handleRunDebug() {
    if (!storedKeys) return;
    setDebugLoading(true);
    addLog('Running debug queries…');
    try {
      const [walletInfo, minerInfo] = await Promise.all([
        getDebugAccountInfo(storedKeys.walletAddress || storedKeys.minerAddress),
        getDebugAccountInfo(storedKeys.minerAddress),
      ]);
      setDebugWalletInfo(walletInfo);
      setDebugMinerInfo(minerInfo);
      addLog(`✓ Debug: wallet acc_type=${walletInfo.accType}, miner acc_type=${minerInfo.accType}`);
    } catch (e: any) {
      addLog(`✗ Debug failed: ${e.message}`);
    } finally {
      setDebugLoading(false);
    }
  }

  // ═══ Build a pastable debug dump ═══
  function buildDebugDump(): string {
    const now = new Date().toISOString();
    const lines: string[] = [];
    lines.push('═══ LISTEN & MINE DEBUG DUMP ═══');
    lines.push(`Generated: ${now}`);
    lines.push(`User agent: ${navigator.userAgent}`);
    lines.push('');
    lines.push('── STATE ──');
    lines.push(`authState: ${authState}`);
    lines.push(`miningActive: ${miningActive}`);
    lines.push(`tapsCount: ${tapsCount}`);
    lines.push(`lastfmUser: ${lastfmUser || '(none)'}`);
    lines.push(`currentTrack: ${currentTrack ? `${currentTrack.artist} — ${currentTrack.title}` : '(none)'}`);
    lines.push('');
    if (storedKeys) {
      lines.push('── STORED KEYS ──');
      lines.push(`walletName: ${storedKeys.walletName}`);
      lines.push(`walletAddress: ${storedKeys.walletAddress}`);
      lines.push(`minerAddress: ${storedKeys.minerAddress}`);
      lines.push(`publicKey: ${storedKeys.publicKey.substring(0, 16)}…${storedKeys.publicKey.substring(storedKeys.publicKey.length - 8)}`);
      lines.push(`secretKey: [${storedKeys.secretKey.length} chars, hidden]`);
      lines.push(`appId: ${storedKeys.appId}`);
      lines.push(`source: ${storedKeys.source}`);
      lines.push(`authorizedAt: ${new Date(storedKeys.authorizedAt).toISOString()}`);
      lines.push('');
    }
    if (walletBalance) {
      lines.push('── WALLET BALANCE (cached) ──');
      lines.push(`network: ${walletBalance.network}`);
      lines.push(`found: ${walletBalance.found}`);
      lines.push(`accType: ${walletBalance.accType}`);
      lines.push(`vmShell: ${walletBalance.vmShell}`);
      lines.push(`nacklFree: ${walletBalance.nacklFree}`);
      lines.push(`shell: ${walletBalance.shell}`);
      lines.push(`usdc: ${walletBalance.usdc}`);
      lines.push(`rawBalanceOther: ${JSON.stringify(walletBalance.rawBalanceOther)}`);
      if (walletBalance.error) lines.push(`error: ${walletBalance.error}`);
      lines.push('');
    }
    if (debugWalletInfo) {
      lines.push('── WALLET DEBUG QUERY ──');
      lines.push(`network: ${debugWalletInfo.network}`);
      lines.push(`accType: ${debugWalletInfo.accType}`);
      lines.push(`balance (VMSHELL nano): ${debugWalletInfo.balance}`);
      lines.push(`balanceOther: ${JSON.stringify(debugWalletInfo.balanceOther)}`);
      lines.push(`codeHash: ${debugWalletInfo.codeHash}`);
      lines.push(`lastPaid: ${debugWalletInfo.lastPaid}`);
      lines.push(`dappId: ${debugWalletInfo.dappId}`);
      if (debugWalletInfo.error) lines.push(`error: ${debugWalletInfo.error}`);
      lines.push('');
    }
    if (debugMinerInfo) {
      lines.push('── MINER CONTRACT DEBUG QUERY ──');
      lines.push(`network: ${debugMinerInfo.network}`);
      lines.push(`accType: ${debugMinerInfo.accType}`);
      lines.push(`balance (VMSHELL nano): ${debugMinerInfo.balance}`);
      lines.push(`balanceOther: ${JSON.stringify(debugMinerInfo.balanceOther)}`);
      lines.push(`codeHash: ${debugMinerInfo.codeHash}`);
      lines.push(`lastPaid: ${debugMinerInfo.lastPaid}`);
      lines.push(`dappId: ${debugMinerInfo.dappId}`);
      if (debugMinerInfo.error) lines.push(`error: ${debugMinerInfo.error}`);
      lines.push('');
    }
    if (minerData) {
      lines.push('── MINER STATS (getMinerData raw) ──');
      lines.push(
        JSON.stringify(
          minerData,
          (_, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v),
          2
        )
      );
      lines.push('');
      if (minerDataAt) {
        lines.push(`lastRefresh: ${new Date(minerDataAt).toISOString()}`);
        lines.push('');
      }
    } else {
      lines.push('── MINER STATS ──');
      lines.push('(not loaded — click "Refresh miner stats" first)');
      lines.push('');
    }
    if (linkedAccounts) {
      lines.push(`── LINKED ACCOUNTS (${linkedAccounts.length}) ──`);
      lines.push(`totalLockedNackl: ${sumLockedNackl(linkedAccounts).toFixed(4)}`);
      for (let i = 0; i < linkedAccounts.length; i++) {
        const a = linkedAccounts[i];
        lines.push(`#${i + 1} ${a.address}`);
        lines.push(`   nackl=${a.nacklBalance.toFixed(4)} shell=${a.shellBalance.toFixed(4)} usdc=${a.usdcBalance.toFixed(4)} vmShell=${a.vmShell.toFixed(4)}`);
        lines.push(`   msgs=${a.messageCount} accType=${a.accType} dappId=${a.dappId || '—'}`);
        lines.push(`   codeHash=${a.codeHash || '—'}`);
      }
      if (linkedAt) lines.push(`lastScan: ${new Date(linkedAt).toISOString()}`);
      lines.push('');
    } else {
      lines.push('── LINKED ACCOUNTS ──');
      lines.push('(not scanned — click "Discover linked accounts" first)');
      lines.push('');
    }
    lines.push('── LAST 40 LOG LINES ──');
    lines.push(...logs.slice(0, 40));
    lines.push('');
    lines.push('═══ END DUMP ═══');
    return lines.join('\n');
  }

  async function handleCopyDebug() {
    // Auto-fetch fresh miner data before dumping, so the user doesn't need to
    // click Refresh first.
    if (storedKeys && !minerData) {
      await refreshMinerData();
    }
    if (storedKeys && !debugWalletInfo) {
      await handleRunDebug();
    }
    if (storedKeys && !linkedAccounts) {
      await refreshLinkedAccounts(
        storedKeys.walletAddress || storedKeys.minerAddress
      );
    }
    const dump = buildDebugDump();
    try {
      await navigator.clipboard.writeText(dump);
      addLog('✓ Debug dump copied to clipboard');
    } catch {
      // Fallback: show in prompt so user can select all
      window.prompt('Copy this debug info:', dump);
    }
  }

  // ═══ Export current keys as JSON ═══
  // Lets the user save the currently-imported keys before disconnecting
  // so they can re-import them later (e.g. when testing a different wallet).
  // Format matches the F12 console output so the same JSON can be pasted back.
  async function handleExportKeys() {
    if (!storedKeys) return;
    const exportObj = {
      wallet_address: storedKeys.walletAddress,
      miner_address: storedKeys.minerAddress,
      keys: {
        public: storedKeys.publicKey,
        secret: storedKeys.secretKey,
      },
      // Metadata for convenience, ignored by the importer
      _meta: {
        walletName: storedKeys.walletName,
        appId: storedKeys.appId,
        source: storedKeys.source,
        exportedAt: new Date().toISOString(),
      },
    };
    const json = JSON.stringify(exportObj, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      addLog('✓ Keys exported to clipboard — paste into a safe note');
    } catch {
      window.prompt(
        'Copy these keys and save them somewhere safe:',
        json
      );
    }
  }

  function handleDisconnectWallet() {
    if (miningActive) handleStopMining();
    clearMiningKeys();
    setStoredKeys(null);
    setWalletBalance(null);
    setWalletNameInput('');
    setAuthState('idle');
    setDebugMinerInfo(null);
    setDebugWalletInfo(null);
    setMinerData(null);
    setMinerDataAt(null);
    setLinkedAccounts(null);
    setLinkedAt(null);
    localStorage.removeItem('lm_wallet_name');
    addLog('Wallet disconnected');
  }

  // ═══ Render ═══
  const isReady = authState === 'ready' && !!storedKeys;

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header__brand">
          <h1 className="header__title">{t(lang, 'title')}</h1>
        </div>
        <div className="header__sub">{t(lang, 'subtitle')}</div>
      </header>

      {/* ═══ WALLET CARD ═══ */}
      <div className={`card ${isReady ? 'card--mining' : 'card--glow'}`}>
        <div className="card__label">{t(lang, 'connectWallet')}</div>

        {!storedKeys ? (
          <>
            <input
              type="text"
              className="input-field"
              placeholder={t(lang, 'walletNamePh')}
              value={walletNameInput}
              onChange={e => setWalletNameInput(e.target.value)}
              style={{ marginBottom: 8 }}
            />

            {authState === 'idle' && !showImportForm && (
              <>
                <button
                  className="btn btn--primary btn--full"
                  onClick={handleAuthorizeMining}
                  disabled={!walletNameInput.trim()}
                >
                  {t(lang, 'authMining')}
                </button>
                <button
                  className="link-btn"
                  onClick={() => setShowImportForm(true)}
                  style={{ marginTop: 10 }}
                >
                  I already have mining keys (advanced) →
                </button>
              </>
            )}

            {authState === 'idle' && showImportForm && (
              <div className="import-form">
                <div className="import-form__title">Import existing mining keys</div>
                <div className="import-form__hint">
                  Paste the JSON output from the F12 console trick (Batteries / Popits / Ludo).
                  Everything is extracted automatically — wallet address, miner address, public &amp; secret keys.
                  Skips the AN Wallet authorization dialog.
                </div>

                {/* Mode tabs */}
                <div className="mode-tabs">
                  <button
                    className={`mode-tab ${importMode === 'json' ? 'mode-tab--active' : ''}`}
                    onClick={() => setImportMode('json')}
                  >
                    📋 Paste JSON
                  </button>
                  <button
                    className={`mode-tab ${importMode === 'manual' ? 'mode-tab--active' : ''}`}
                    onClick={() => setImportMode('manual')}
                  >
                    ✏️ Enter manually
                  </button>
                </div>

                {importMode === 'json' && (
                  <>
                    <label className="import-label">JSON from F12 console</label>
                    <textarea
                      className="input-field import-textarea"
                      placeholder='{"wallet_address":"0:...","miner_address":"0:...","keys":{"public":"...","secret":"..."}}'
                      value={importJson}
                      onChange={e => setImportJson(e.target.value)}
                      rows={6}
                    />
                  </>
                )}

                {importMode === 'manual' && (
                  <>
                    <label className="import-label">Wallet address</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="0:..."
                      value={importWalletAddr}
                      onChange={e => setImportWalletAddr(e.target.value)}
                    />

                    <label className="import-label">Miner address</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="0:..."
                      value={importMinerAddr}
                      onChange={e => setImportMinerAddr(e.target.value)}
                    />

                    <label className="import-label">Public key</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="64-char hex string"
                      value={importPublic}
                      onChange={e => setImportPublic(e.target.value)}
                    />

                    <label className="import-label">
                      Secret key (stays in your browser)
                    </label>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="64-char hex string — never shared"
                      value={importSecret}
                      onChange={e => setImportSecret(e.target.value)}
                    />
                  </>
                )}

                <label className="import-label">Source app (determines APP_ID)</label>
                <select
                  className="input-field"
                  value={importAppId}
                  onChange={e => setImportAppId(e.target.value)}
                >
                  <option value={APP_IDS.popits}>Popits (0x…0001)</option>
                  <option value={APP_IDS.batteries}>Batteries (0x…0002)</option>
                </select>

                <div className="import-hint-small">
                  ⚠️ Match this to the TMA where you extracted the keys. Using the wrong APP_ID
                  causes the Miner contract to reject the taps.
                </div>

                <button
                  className="btn btn--primary btn--full"
                  onClick={handleImportKeys}
                  disabled={
                    importMode === 'json'
                      ? !importJson.trim()
                      : !importWalletAddr.trim() ||
                        !importMinerAddr.trim() ||
                        !importPublic.trim() ||
                        !importSecret.trim()
                  }
                  style={{ marginTop: 12 }}
                >
                  Load miner with imported keys
                </button>
                <button
                  className="link-btn"
                  onClick={() => setShowImportForm(false)}
                  style={{ marginTop: 8 }}
                >
                  ← Back to standard authorization
                </button>
              </div>
            )}

            {authState === 'generating' && (
              <div className="auth-status">⏳ {t(lang, 'authStep1')}</div>
            )}

            {(authState === 'awaiting' || authState === 'propagating') && deepLink && (
              <>
                <div className="auth-status">
                  📱 {t(lang, 'authStep2')}
                  {authState === 'propagating' && (
                    <>
                      <br />
                      ⏳ {t(lang, 'authStep3')}
                    </>
                  )}
                </div>

                <div className="qr-box">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=12&bgcolor=0c1220&color=00d4ff&data=${encodeURIComponent(deepLink)}`}
                    alt="AN Wallet QR Code"
                    className="qr-image"
                  />
                  <div className="qr-hint">
                    📷 Scan with your phone where AN Wallet is installed
                  </div>
                </div>

                <a
                  className="btn btn--primary btn--full"
                  href={deepLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(lang, 'openWallet')} → (mobile only)
                </a>
              </>
            )}

            {authState === 'error' && (
              <>
                <div className="auth-status auth-status--error">
                  ✗ {t(lang, 'authError')}: {authError}
                </div>
                <button
                  className="btn btn--full"
                  onClick={() => setAuthState('idle')}
                  style={{ marginTop: 8 }}
                >
                  Retry
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <div className="wallet-name-row">
              <span className="wallet-name">{storedKeys.walletName}</span>
              <span className="badge badge--success">✓ {t(lang, 'authReady')}</span>
            </div>

            <div className="addr-row">
              <div className="addr-label">Wallet</div>
              <div className="addr-value">
                {(storedKeys.walletAddress || storedKeys.minerAddress).substring(0, 10)}…
                {(storedKeys.walletAddress || storedKeys.minerAddress).substring(
                  (storedKeys.walletAddress || storedKeys.minerAddress).length - 8
                )}
              </div>
              <a
                className="addr-link"
                href={explorerAccountUrl(storedKeys.walletAddress || storedKeys.minerAddress)}
                target="_blank"
                rel="noreferrer"
              >
                explorer ↗
              </a>
            </div>
            <div className="addr-row">
              <div className="addr-label">Miner</div>
              <div className="addr-value">
                {storedKeys.minerAddress.substring(0, 10)}…
                {storedKeys.minerAddress.substring(storedKeys.minerAddress.length - 8)}
              </div>
              <a
                className="addr-link"
                href={explorerAccountUrl(storedKeys.minerAddress)}
                target="_blank"
                rel="noreferrer"
              >
                explorer ↗
              </a>
            </div>

            {walletBalance?.found && (
              <div className="wallet-grid">
                <div className="wallet-stat">
                  <div className="wallet-stat__label">{t(lang, 'nacklFree')}</div>
                  <div className="wallet-stat__value">{walletBalance.nacklFree}</div>
                </div>
                <div className="wallet-stat">
                  <div className="wallet-stat__label">{t(lang, 'shell')}</div>
                  <div className="wallet-stat__value">{walletBalance.shell}</div>
                </div>
                <div className="wallet-stat">
                  <div className="wallet-stat__label">{t(lang, 'usdc')}</div>
                  <div className="wallet-stat__value">{walletBalance.usdc}</div>
                </div>
                <div className="wallet-stat">
                  <div className="wallet-stat__label">{t(lang, 'network')}</div>
                  <div className="wallet-stat__value wallet-stat__value--small">
                    {walletBalance.network}
                  </div>
                </div>
              </div>
            )}

            {/* ═══ NACKL LOCKED — discovered from linked accounts ═══ */}
            <div className="locked-block">
              <div className="locked-block__label">
                🔒 NACKL LOCKED
                {linkedAccounts && linkedAccounts.length > 0 && (
                  <span className="locked-block__count">
                    ({linkedAccounts.length} linked contracts)
                  </span>
                )}
              </div>
              <div className="locked-block__value">
                {linkedLoading
                  ? '⏳ scanning…'
                  : lockedNackl !== null
                    ? lockedNackl.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    : '—'}
              </div>
              <div className="locked-block__hint">
                {linkedAccounts === null
                  ? 'Click below to discover linked contracts (Mamaboard, game contracts, etc).'
                  : linkedAccounts.length === 0
                    ? 'No outbound messages found from this wallet.'
                    : `Top holder: ${linkedAccounts[0].address.substring(0, 10)}…${linkedAccounts[0].address.substring(linkedAccounts[0].address.length - 6)} (${linkedAccounts[0].nacklBalance.toFixed(2)} NACKL)`}
              </div>
              {linkedAt && (
                <div className="locked-block__ts">
                  Last scan: {new Date(linkedAt).toLocaleTimeString()}
                </div>
              )}
              <button
                className="btn btn--full"
                onClick={() =>
                  refreshLinkedAccounts(
                    storedKeys.walletAddress || storedKeys.minerAddress
                  )
                }
                disabled={linkedLoading}
                style={{ marginTop: 8 }}
              >
                {linkedLoading ? '⏳ Scanning chain…' : '🔍 Discover / refresh linked accounts'}
              </button>
            </div>

            <button
              className="btn btn--full"
              onClick={() =>
                refreshBalance(storedKeys.walletAddress || storedKeys.minerAddress)
              }
              disabled={walletLoading}
              style={{ marginTop: 12 }}
            >
              {walletLoading ? '…' : `↻ ${t(lang, 'refresh')}`}
            </button>
            <button
              className="btn btn--full"
              onClick={handleExportKeys}
              style={{ marginTop: 8 }}
              title="Copy the current keys as JSON so you can re-import them later"
            >
              📤 Export keys as JSON
            </button>
            <button
              className="btn btn--back btn--full"
              onClick={handleDisconnectWallet}
              style={{ marginTop: 8 }}
            >
              🔓 {t(lang, 'disconnect')}
            </button>
          </>
        )}
      </div>

      {/* ═══ MINER STATS CARD ═══ */}
      {isReady && (
        <div className="card">
          <div className="card__label">⛏ Miner contract stats</div>

          {!minerData && !minerDataLoading && (
            <div className="miner-stats-empty">
              Click below to read the full state of your Miner contract
              (tapSum, commitTaps, mining duration, pending rewards if any).
            </div>
          )}

          {minerDataLoading && (
            <div className="miner-stats-empty">⏳ Reading miner contract…</div>
          )}

          {minerData && (
            <>
              <div className="miner-stats-grid">
                {(() => {
                  // Flexible renderer: works with snake_case or camelCase keys
                  const get = (obj: any, ...keys: string[]) => {
                    for (const k of keys) {
                      if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
                    }
                    return undefined;
                  };
                  const fmt = (v: any): string => {
                    if (v === undefined || v === null) return '—';
                    if (typeof v === 'bigint') return v.toString();
                    if (typeof v === 'object') return JSON.stringify(v);
                    return String(v);
                  };
                  const fmtNackl = (v: any): string => {
                    if (v === undefined || v === null) return '—';
                    try {
                      const n = typeof v === 'bigint' ? Number(v) : parseFloat(String(v));
                      if (isNaN(n)) return fmt(v);
                      return (n / 1e9).toFixed(4);
                    } catch {
                      return fmt(v);
                    }
                  };

                  const tapSum = get(minerData, 'tap_sum', 'tapSum', '_tapSum');
                  const modifiedTapSum = get(minerData, 'modified_tap_sum', 'modifiedTapSum', '_modifiedTapSum');
                  const tapSum5m = get(minerData, 'tap_sum_5m', 'tapSum5m', '_tapSum5m');
                  const commitTaps = get(minerData, 'commit_taps', 'commitTaps', '_commitTaps');
                  const miningDurSum = get(minerData, 'mining_dur_sum', 'miningDurSum', '_miningDurSum');
                  const easyComplexity = get(minerData, 'easy_complexity', 'easyComplexity', '_easyComplexity');
                  const hardComplexity = get(minerData, 'hard_complexity', 'hardComplexity', '_hardComplexity');
                  const boost = get(minerData, 'boost', '_boost');
                  const epochStart = get(minerData, 'epoch_start', 'epochStart', '_epochStart');
                  // Look for any field that might contain pending reward
                  const pendingReward = get(
                    minerData,
                    'pending_reward', 'pendingReward',
                    'reward', 'accumulated_reward',
                    'locked_nackl', 'lockedNackl',
                    'nackl_locked', 'nacklLocked'
                  );

                  return (
                    <>
                      {pendingReward !== undefined && (
                        <div className="miner-stat miner-stat--highlight">
                          <div className="miner-stat__label">🔒 PENDING REWARD</div>
                          <div className="miner-stat__value">{fmtNackl(pendingReward)}</div>
                        </div>
                      )}
                      <div className="miner-stat">
                        <div className="miner-stat__label">Tap sum</div>
                        <div className="miner-stat__value">{fmt(tapSum)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Modified tap sum</div>
                        <div className="miner-stat__value">{fmt(modifiedTapSum)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Tap sum 5m</div>
                        <div className="miner-stat__value">{fmt(tapSum5m)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Commit taps</div>
                        <div className="miner-stat__value">{fmt(commitTaps)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Mining dur sum</div>
                        <div className="miner-stat__value">{fmt(miningDurSum)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Boost</div>
                        <div className="miner-stat__value">{fmt(boost)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Easy complexity</div>
                        <div className="miner-stat__value">{fmt(easyComplexity)}</div>
                      </div>
                      <div className="miner-stat">
                        <div className="miner-stat__label">Hard complexity</div>
                        <div className="miner-stat__value">{fmt(hardComplexity)}</div>
                      </div>
                      <div className="miner-stat miner-stat--wide">
                        <div className="miner-stat__label">Epoch start</div>
                        <div className="miner-stat__value">{fmt(epochStart)}</div>
                      </div>
                    </>
                  );
                })()}
              </div>

              <details className="miner-raw">
                <summary>Raw JSON (for debugging)</summary>
                <pre className="miner-raw__json">
                  {JSON.stringify(
                    minerData,
                    (_, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v),
                    2
                  )}
                </pre>
              </details>

              {minerDataAt && (
                <div className="miner-stats-ts">
                  Last refresh: {new Date(minerDataAt).toLocaleTimeString()}
                </div>
              )}
            </>
          )}

          <button
            className="btn btn--full"
            onClick={refreshMinerData}
            disabled={minerDataLoading}
            style={{ marginTop: 12 }}
          >
            {minerDataLoading ? '…' : '↻ Refresh miner stats'}
          </button>
        </div>
      )}

      {/* ═══ LAST.FM CARD ═══ */}
      <div className="card">
        <div className="card__label">Last.fm</div>
        {!lastfmUser ? (
          <>
            <input
              type="text"
              className="input-field"
              placeholder={t(lang, 'lastfmUser')}
              value={lastfmInput}
              onChange={e => setLastfmInput(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <button
              className="btn btn--primary btn--full"
              onClick={handleSetLastfm}
              disabled={!lastfmInput.trim()}
            >
              {t(lang, 'setupLastfm')}
            </button>
          </>
        ) : (
          <>
            <div className="lastfm-user">@{lastfmUser}</div>
            {currentTrack ? (
              <div className="now-playing">
                <div className="now-playing__icon">♪</div>
                <div>
                  <div className="now-playing__title">{currentTrack.title}</div>
                  <div className="now-playing__artist">{currentTrack.artist}</div>
                </div>
              </div>
            ) : (
              <div className="now-playing-empty">{t(lang, 'waitingMusic')}</div>
            )}
            <button
              className="btn btn--back btn--full"
              onClick={handleDisconnectLastfm}
              style={{ marginTop: 12 }}
            >
              {t(lang, 'disconnect')}
            </button>
          </>
        )}
      </div>

      {/* ═══ MINING CONTROL CARD ═══ */}
      {isReady && lastfmUser && (
        <div className={`card ${miningActive ? 'card--mining' : ''}`}>
          <div className="card__label">{t(lang, 'miningStatus')}</div>

          <div className="mining-status">
            <span className={`badge ${miningActive ? 'badge--success' : 'badge--idle'}`}>
              {miningActive ? `▶ ${t(lang, 'mining')}` : `⏸ ${t(lang, 'notMining')}`}
            </span>
            {miningActive && (
              <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-muted)' }}>
                {t(lang, 'sessionTaps')}: <strong>{tapsCount}</strong>
              </span>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            {!miningActive ? (
              <button className="btn btn--primary btn--full" onClick={handleStartMining}>
                {t(lang, 'startMining')}
              </button>
            ) : (
              <button className="btn btn--full" onClick={handleStopMining}>
                {t(lang, 'stopMining')}
              </button>
            )}
          </div>
          <div className="mining-info">
            ℹ️ Rewards are collected automatically when session data is submitted on-chain.
            Check your wallet balance after a few completed sessions.
          </div>
          <div className="mining-warning">
            ⚠️ <strong>Keep the TMA in foreground during mining.</strong> On mobile, iOS/Android
            throttle background timers, so if you lock the screen or switch app the tap loop
            slows down or stops mid-session. We acquire a screen wake lock on Start, but
            the OS can still release it in sleep mode.
          </div>
        </div>
      )}

      {/* ═══ SESSION LOG ═══ */}
      <div className="card">
        <div className="card__label">{t(lang, 'log')}</div>
        <div className="log">
          {logs.length === 0 ? (
            <div className="log-empty">—</div>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="log-entry">{line}</div>
            ))
          )}
        </div>
      </div>

      {/* ═══ DEBUG PANEL ═══ */}
      <div className="card">
        <div className="card__label">
          <button
            className="debug-toggle"
            onClick={() => setShowDebug(s => !s)}
          >
            {showDebug ? '▼' : '▶'} Debug
          </button>
        </div>
        {showDebug && (
          <div className="debug-body">
            <div className="debug-hint">
              Use this panel to inspect on-chain state and copy a diagnostic dump.
            </div>

            <div className="debug-actions">
              <button
                className="btn btn--full"
                onClick={handleRunDebug}
                disabled={!storedKeys || debugLoading}
              >
                {debugLoading ? 'Querying…' : '⚡ Run on-chain debug queries'}
              </button>
              <button
                className="btn btn--full"
                onClick={handleCopyDebug}
                style={{ marginTop: 8 }}
              >
                📋 Copy debug dump to clipboard
              </button>
            </div>

            {storedKeys && (
              <>
                <div className="debug-section">
                  <div className="debug-section__title">Stored keys</div>
                  <div className="debug-kv">
                    <span>walletName</span>
                    <code>{storedKeys.walletName}</code>
                  </div>
                  <div className="debug-kv">
                    <span>appId</span>
                    <code>{storedKeys.appId.substring(0, 10)}…{storedKeys.appId.substring(storedKeys.appId.length - 4)}</code>
                  </div>
                  <div className="debug-kv">
                    <span>source</span>
                    <code>{storedKeys.source}</code>
                  </div>
                  <div className="debug-kv">
                    <span>publicKey</span>
                    <code>{storedKeys.publicKey.substring(0, 16)}…</code>
                  </div>
                  <div className="debug-kv">
                    <span>walletAddress</span>
                    <code className="debug-addr">{storedKeys.walletAddress}</code>
                  </div>
                  <div className="debug-kv">
                    <span>minerAddress</span>
                    <code className="debug-addr">{storedKeys.minerAddress}</code>
                  </div>
                </div>
              </>
            )}

            {debugWalletInfo && (
              <div className="debug-section">
                <div className="debug-section__title">Wallet on-chain ({debugWalletInfo.network})</div>
                <div className="debug-kv">
                  <span>acc_type</span>
                  <code>{debugWalletInfo.accType ?? 'null'}</code>
                </div>
                <div className="debug-kv">
                  <span>VMSHELL (nano)</span>
                  <code>{debugWalletInfo.balance}</code>
                </div>
                <div className="debug-kv">
                  <span>balance_other</span>
                  <code>{JSON.stringify(debugWalletInfo.balanceOther)}</code>
                </div>
                <div className="debug-kv">
                  <span>dapp_id</span>
                  <code className="debug-addr">{debugWalletInfo.dappId || '—'}</code>
                </div>
                <div className="debug-kv">
                  <span>last_paid</span>
                  <code>{debugWalletInfo.lastPaid || '—'}</code>
                </div>
                {debugWalletInfo.error && (
                  <div className="debug-kv">
                    <span>error</span>
                    <code className="debug-error">{debugWalletInfo.error}</code>
                  </div>
                )}
              </div>
            )}

            {debugMinerInfo && (
              <div className="debug-section">
                <div className="debug-section__title">Miner contract on-chain ({debugMinerInfo.network})</div>
                <div className="debug-kv">
                  <span>acc_type</span>
                  <code>{debugMinerInfo.accType ?? 'null'}</code>
                </div>
                <div className="debug-kv">
                  <span>VMSHELL (nano)</span>
                  <code>{debugMinerInfo.balance}</code>
                </div>
                <div className="debug-kv">
                  <span>balance_other</span>
                  <code>{JSON.stringify(debugMinerInfo.balanceOther)}</code>
                </div>
                <div className="debug-kv">
                  <span>dapp_id</span>
                  <code className="debug-addr">{debugMinerInfo.dappId || '—'}</code>
                </div>
                <div className="debug-kv">
                  <span>last_paid</span>
                  <code>{debugMinerInfo.lastPaid || '—'}</code>
                </div>
                {debugMinerInfo.error && (
                  <div className="debug-kv">
                    <span>error</span>
                    <code className="debug-error">{debugMinerInfo.error}</code>
                  </div>
                )}
              </div>
            )}

            {linkedAccounts && linkedAccounts.length > 0 && (
              <div className="debug-section">
                <div className="debug-section__title">
                  Linked accounts ({linkedAccounts.length})
                </div>
                <div className="debug-hint">
                  Contracts this wallet has sent messages to, sorted by NACKL balance.
                  The top entries are typically Mamaboards, game contracts, or other
                  reward holders. Tap "explorer" to inspect any of them.
                </div>
                {linkedAccounts.map((acc, i) => (
                  <div key={acc.address} className="linked-entry">
                    <div className="linked-entry__header">
                      <span className="linked-entry__rank">#{i + 1}</span>
                      <a
                        className="linked-entry__addr"
                        href={explorerAccountUrl(acc.address)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {acc.address.substring(0, 12)}…
                        {acc.address.substring(acc.address.length - 8)} ↗
                      </a>
                    </div>
                    <div className="linked-entry__grid">
                      <div>
                        <span className="linked-entry__k">NACKL</span>
                        <span className="linked-entry__v linked-entry__v--highlight">
                          {acc.nacklBalance.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="linked-entry__k">SHELL</span>
                        <span className="linked-entry__v">{acc.shellBalance.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="linked-entry__k">USDC</span>
                        <span className="linked-entry__v">{acc.usdcBalance.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="linked-entry__k">msgs</span>
                        <span className="linked-entry__v">{acc.messageCount}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="debug-section">
              <div className="debug-section__title">Disconnect / reset</div>
              <button
                className="btn btn--back btn--full"
                onClick={handleDisconnectWallet}
                style={{ marginTop: 8 }}
              >
                {t(lang, 'disconnect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
