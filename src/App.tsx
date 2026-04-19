import { useState, useEffect, useRef } from 'react';
import {
  getWalletBalance,
  getDebugAccountInfo,
  explorerAccountUrl,
  type WalletBalance,
  type DebugAccountInfo,
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
  saveMiningKeys,
  loadMiningKeys,
  clearMiningKeys,
  APP_ID,
  type StoredMiningKeys,
} from './services/bee-sdk';
import {
  discoverLinkedAccounts,
  getLockedNackl,
  guessMamaboard,
} from './services/mamaboard';
import { detectLang, isRTL, t, type Lang } from './services/i18n';

type AuthState = 'idle' | 'generating' | 'awaiting' | 'propagating' | 'ready' | 'error';

// Session duration passed to Miner.start(duration_ms, callback).
// Tuned for a ~5 min mining window; the SDK auto-stops at expiry and submits
// session results to the Miner contract internally.
const SESSION_DURATION_MS = 330_000;

// Auto-tap cadence: one Miner.add_tap(x,y) every TAP_INTERVAL_MS while the
// session is active. Tap count of ~70 per session keeps the Merkle tree dense
// without hammering the WASM module.
const TAP_INTERVAL_MS = 4710;

export default function App() {
  // ═══ Language ═══
  const [lang] = useState<Lang>(detectLang());

  // ═══ Wallet ═══
  const [walletNameInput, setWalletNameInput] = useState(
    () => localStorage.getItem('lm_wallet_name') || ''
  );
  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);

  // ═══ NACKL Locked tracker ═══
  // Mamaboard contract address holds the user's accumulated mining rewards.
  // The miner contract does NOT hold NACKL itself — it only witnesses session
  // submissions. The wallet address is needed to auto-discover the Mamaboard
  // via outbound-message scan (it's not stored by the mining flow, which only
  // persists walletName + minerAddress).
  const LOCKED_WALLET_ADDR_KEY = 'lm_wallet_address_v1';
  const LOCKED_MAMABOARD_KEY = 'lm_mamaboard_address_v1';
  const LOCKED_SAMPLES_KEY = 'lm_locked_samples_v1';
  interface LockedSample {
    value: number;
    timestamp: number;
    note?: string;
    source: 'auto' | 'manual';
  }
  const [walletAddressInput, setWalletAddressInput] = useState(
    () => localStorage.getItem(LOCKED_WALLET_ADDR_KEY) || ''
  );
  const [mamaboardInput, setMamaboardInput] = useState(
    () => localStorage.getItem(LOCKED_MAMABOARD_KEY) || ''
  );
  const [lockedSamples, setLockedSamples] = useState<LockedSample[]>(() => {
    try {
      const raw = localStorage.getItem(LOCKED_SAMPLES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [lockedReadLoading, setLockedReadLoading] = useState(false);
  const [newSampleValue, setNewSampleValue] = useState('');
  const [newSampleNote, setNewSampleNote] = useState('');
  const [showManualEntry, setShowManualEntry] = useState(false);

  // ═══ Last.fm ═══
  const [lastfmInput, setLastfmInput] = useState('');
  const [lastfmUser, setLastfmUser] = useState(
    () => localStorage.getItem('lm_lastfm_user') || ''
  );
  const [currentTrack, setCurrentTrack] = useState<LastFmTrack | null>(null);
  const trackMonitorRef = useRef<TrackMonitor | null>(null);

  // Mining auto-tap loop (fires every TAP_INTERVAL_MS while session active).
  // No external session-end timer: the SDK finalizes at duration_ms on its own.
  const tapTimerRef = useRef<number | null>(null);
  const tapCoordsRef = useRef({ x: 200, y: 200 });
  const tapsCountRef = useRef(0);

  // ═══ Mining auth ═══
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [authError, setAuthError] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [storedKeys, setStoredKeys] = useState<StoredMiningKeys | null>(
    () => loadMiningKeys()
  );

  // ═══ Debug panel ═══
  const [showDebug, setShowDebug] = useState(false);
  const [debugMinerInfo, setDebugMinerInfo] = useState<DebugAccountInfo | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

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
  // NOTE: in the official Bee Engine flow we only persist the miner contract
  // address. Querying its balance is mostly informational (miner contracts
  // don't hold NACKL). The real wallet balance lookup will be wired up as
  // part of the NACKL Locked tracker (Request 5).
  useEffect(() => {
    if (storedKeys) {
      refreshBalance(storedKeys.minerAddress);
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
      // Step 1 — generate mining keys for our APP_ID
      const keys = await generateMiningKeys(name);
      addLog(`Mining keys generated. Public: ${keys.publicKey.substring(0, 16)}…`);

      // Step 2 — resolve miner contract address from wallet name
      addLog(`Resolving miner address for "${name}"…`);
      const minerAddress = await resolveMinerAddress(name);
      addLog(`Miner address: ${minerAddress.substring(0, 24)}…`);

      // Step 3 — present deep_link to user (QR + button) for AN Wallet confirmation
      setDeepLink(keys.deepLink);
      setAuthState('awaiting');
      addLog('Open AN Wallet via the button below to confirm');

      // Step 4 — poll for on-chain propagation of the authorization
      setAuthState('propagating');
      addLog('Waiting for on-chain confirmation…');
      await waitForAuthorization(minerAddress, keys.publicKey, 180, 2000);
      addLog('✓ Mining keys propagated on-chain');

      // Step 5 — create the Miner instance
      await createMiner(minerAddress, keys.publicKey, keys.secretKey);
      addLog('✓ Miner instance ready');

      // Persist for next sessions (secret stays in localStorage, browser-only)
      const stored: StoredMiningKeys = {
        walletName: name,
        minerAddress,
        publicKey: keys.publicKey,
        secretKey: keys.secretKey,
        appId: APP_ID,
        authorizedAt: Date.now(),
      };
      saveMiningKeys(stored);
      setStoredKeys(stored);
      setAuthState('ready');
      setDeepLink('');

      refreshBalance(minerAddress);
    } catch (e: any) {
      setAuthState('error');
      setAuthError(e.message || 'Unknown error');
      addLog(`✗ Auth failed: ${e.message}`);
    }
  }

  async function handleResumeFromStored() {
    if (!storedKeys) return;
    addLog('Resuming with stored keys…');
    try {
      await createMiner(
        storedKeys.minerAddress,
        storedKeys.publicKey,
        storedKeys.secretKey
      );
      setAuthState('ready');
      addLog('✓ Miner restored');
      refreshBalance(storedKeys.minerAddress);
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
      // Log whatever the SDK emits verbatim. We need to observe the shape
      // of completion signals (if any) when the internal session timer
      // expires. Previously an external setTimeout called miner.stop() at
      // duration_ms, aborting submit_session_root before it could fire.
      let payload: string;
      if (typeof event === 'string') payload = event;
      else {
        try { payload = JSON.stringify(event); }
        catch { payload = String(event); }
      }
      addLog(`📡 SDK event: ${payload}`);
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

    // Reset coordinate drift starting point
    tapCoordsRef.current = {
      x: 100 + Math.floor(Math.random() * 200),
      y: 100 + Math.floor(Math.random() * 300),
    };

    // Start auto-tap loop — one Miner.add_tap(x,y) every TAP_INTERVAL_MS.
    // Coordinates are app-defined (per Bee Engine docs); a random-walk drift
    // keeps them varied across the session.
    tapTimerRef.current = window.setInterval(() => {
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
  }

  function handleStopMining() {
    if (tapTimerRef.current !== null) {
      window.clearInterval(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    stopMining();
    setMiningActive(false);
    addLog(`Session stopped. Total taps: ${tapsCountRef.current}`);
  }

  // ═══ Debug runner — fetches on-chain state for the miner contract ═══
  async function handleRunDebug() {
    if (!storedKeys) return;
    setDebugLoading(true);
    addLog('Running debug query…');
    try {
      const minerInfo = await getDebugAccountInfo(storedKeys.minerAddress);
      setDebugMinerInfo(minerInfo);
      addLog(`✓ Debug: miner acc_type=${minerInfo.accType}`);
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
      lines.push(`minerAddress: ${storedKeys.minerAddress}`);
      lines.push(`publicKey: ${storedKeys.publicKey.substring(0, 16)}…${storedKeys.publicKey.substring(storedKeys.publicKey.length - 8)}`);
      lines.push(`secretKey: [${storedKeys.secretKey.length} chars, hidden]`);
      lines.push(`appId: ${storedKeys.appId}`);
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
    lines.push('── LAST 40 LOG LINES ──');
    lines.push(...logs.slice(0, 40));
    lines.push('');
    lines.push('═══ END DUMP ═══');
    return lines.join('\n');
  }

  async function handleCopyDebug() {
    const dump = buildDebugDump();
    try {
      await navigator.clipboard.writeText(dump);
      addLog('✓ Debug dump copied to clipboard');
    } catch {
      // Fallback: show in prompt so user can select all
      window.prompt('Copy this debug info:', dump);
    }
  }

  // ═══ NACKL Locked handlers ═══
  function persistWalletAddress(v: string) {
    setWalletAddressInput(v);
    const trimmed = v.trim();
    if (trimmed) localStorage.setItem(LOCKED_WALLET_ADDR_KEY, trimmed);
    else localStorage.removeItem(LOCKED_WALLET_ADDR_KEY);
  }

  function persistMamaboard(v: string) {
    setMamaboardInput(v);
    const trimmed = v.trim();
    if (trimmed) localStorage.setItem(LOCKED_MAMABOARD_KEY, trimmed);
    else localStorage.removeItem(LOCKED_MAMABOARD_KEY);
  }

  function appendLockedSample(sample: LockedSample) {
    setLockedSamples(prev => {
      const next = [sample, ...prev].slice(0, 50);
      localStorage.setItem(LOCKED_SAMPLES_KEY, JSON.stringify(next));
      return next;
    });
  }

  function handleDeleteLockedSample(idx: number) {
    setLockedSamples(prev => {
      const next = prev.filter((_, i) => i !== idx);
      localStorage.setItem(LOCKED_SAMPLES_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function handleDiscoverMamaboard() {
    const wallet = walletAddressInput.trim();
    if (!wallet) { addLog('✗ Paste wallet address first'); return; }
    setDiscoveryLoading(true);
    addLog('🔍 Scanning outbound messages to discover Mamaboard…');
    try {
      const linked = await discoverLinkedAccounts(wallet);
      const best = guessMamaboard(linked);
      if (best) {
        persistMamaboard(best.address);
        addLog(`✓ Mamaboard candidate: ${best.address.substring(0, 12)}… (${best.nackl.toFixed(2)} NACKL, ${best.messageCount} msgs)`);
      } else {
        addLog(`✗ No NACKL-holding contract among ${linked.length} linked accounts — paste Mamaboard address manually`);
      }
    } catch (e: any) {
      addLog(`✗ Discovery failed: ${e.message}`);
    } finally {
      setDiscoveryLoading(false);
    }
  }

  // Reads Mamaboard locked NACKL and appends a sample if the value changed
  // vs the latest stored sample. `silent=true` suppresses log lines for the
  // automatic polling path.
  async function readLockedNow(silent = false) {
    const addr = mamaboardInput.trim();
    if (!addr) {
      if (!silent) addLog('✗ Set Mamaboard address first');
      return;
    }
    setLockedReadLoading(true);
    try {
      const read = await getLockedNackl(addr);
      setLockedSamples(prev => {
        const latest = prev[0];
        if (latest && latest.value === read.nackl) {
          if (!silent) addLog(`· Locked NACKL unchanged: ${read.nackl.toFixed(4)}`);
          return prev;
        }
        const autoSample: LockedSample = {
          value: read.nackl,
          timestamp: read.timestamp,
          source: 'auto',
        };
        const next: LockedSample[] = [autoSample, ...prev].slice(0, 50);
        localStorage.setItem(LOCKED_SAMPLES_KEY, JSON.stringify(next));
        if (!silent) addLog(`✓ Locked NACKL: ${read.nackl.toFixed(4)} (${read.network})`);
        return next;
      });
    } catch (e: any) {
      if (!silent) addLog(`✗ Read locked failed: ${e.message}`);
    } finally {
      setLockedReadLoading(false);
    }
  }

  function handleAddManualSample() {
    const normalized = newSampleValue.replace(/\s/g, '').replace(',', '.');
    const v = parseFloat(normalized);
    if (isNaN(v) || v < 0) { addLog('✗ Invalid NACKL value'); return; }
    appendLockedSample({
      value: v,
      timestamp: Date.now(),
      note: newSampleNote.trim() || undefined,
      source: 'manual',
    });
    setNewSampleValue('');
    setNewSampleNote('');
    addLog(`✓ Manual locked sample: ${v.toFixed(4)}`);
  }

  // Derived stats: delta + rate between newest and oldest sample.
  // Null when we have <2 samples (rate would be meaningless).
  const lockedStats = (() => {
    if (lockedSamples.length < 2) return null;
    const latest = lockedSamples[0];
    const oldest = lockedSamples[lockedSamples.length - 1];
    const delta = latest.value - oldest.value;
    const elapsedMs = latest.timestamp - oldest.timestamp;
    const hours = elapsedMs / 3_600_000;
    const rate = hours > 0 ? delta / hours : 0;
    return { latest, oldest, delta, elapsedMs, rateNacklPerHour: rate };
  })();

  function formatLockedDuration(ms: number): string {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // Auto-read locked NACKL every 60s while a mining session is active.
  // On-demand ("Read now") button handles the idle case.
  useEffect(() => {
    if (!miningActive) return;
    if (!mamaboardInput.trim()) return;
    const id = window.setInterval(() => { readLockedNow(true); }, 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miningActive, mamaboardInput]);

  // One-shot read on mount if we already have a Mamaboard address cached.
  useEffect(() => {
    if (mamaboardInput.trim()) readLockedNow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDisconnectWallet() {
    if (miningActive) handleStopMining();
    clearMiningKeys();
    setStoredKeys(null);
    setWalletBalance(null);
    setWalletNameInput('');
    setAuthState('idle');
    setDebugMinerInfo(null);
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

            {authState === 'idle' && (
              <button
                className="btn btn--primary btn--full"
                onClick={handleAuthorizeMining}
                disabled={!walletNameInput.trim()}
              >
                {t(lang, 'authMining')}
              </button>
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

            <button
              className="btn btn--full"
              onClick={() => refreshBalance(storedKeys.minerAddress)}
              disabled={walletLoading}
              style={{ marginTop: 12 }}
            >
              {walletLoading ? '…' : `↻ ${t(lang, 'refresh')}`}
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

      {/* ═══ NACKL LOCKED TRACKER CARD ═══ */}
      {storedKeys && (
        <div className="card">
          <div className="card__label">🔒 {t(lang, 'lockedTitle')}</div>
          <div className="locked-hint">{t(lang, 'lockedHint')}</div>

          {/* Current value + delta + rate */}
          {lockedStats ? (
            <div className="locked-stats">
              <div className="locked-stat">
                <div className="locked-stat__label">{t(lang, 'latest')}</div>
                <div className="locked-stat__value">
                  {lockedStats.latest.value.toLocaleString('en-US', {
                    minimumFractionDigits: 2, maximumFractionDigits: 2,
                  })}
                </div>
                <div className="locked-stat__sub">
                  {new Date(lockedStats.latest.timestamp).toLocaleTimeString()}
                </div>
              </div>
              <div className="locked-stat">
                <div className="locked-stat__label">{t(lang, 'delta')}</div>
                <div className={`locked-stat__value ${lockedStats.delta >= 0 ? 'locked-stat__value--pos' : 'locked-stat__value--neg'}`}>
                  {lockedStats.delta >= 0 ? '+' : ''}{lockedStats.delta.toFixed(4)}
                </div>
                <div className="locked-stat__sub">
                  {formatLockedDuration(lockedStats.elapsedMs)}
                </div>
              </div>
              <div className="locked-stat">
                <div className="locked-stat__label">{t(lang, 'ratePerHour')}</div>
                <div className="locked-stat__value">
                  {lockedStats.rateNacklPerHour.toFixed(4)}
                </div>
                <div className="locked-stat__sub">·</div>
              </div>
            </div>
          ) : lockedSamples.length === 1 ? (
            <div className="locked-single">
              {lockedSamples[0].value.toLocaleString('en-US', {
                minimumFractionDigits: 2, maximumFractionDigits: 2,
              })} NACKL · {new Date(lockedSamples[0].timestamp).toLocaleTimeString()}
            </div>
          ) : (
            <div className="locked-empty">{t(lang, 'noSamples')}</div>
          )}

          {/* Wallet address + auto-discover */}
          <div className="locked-field-label">{t(lang, 'walletAddressLabel')}</div>
          <input
            type="text"
            className="input-field"
            placeholder={t(lang, 'walletAddressPh')}
            value={walletAddressInput}
            onChange={e => persistWalletAddress(e.target.value)}
            spellCheck={false}
            style={{ marginBottom: 6 }}
          />
          <button
            className="btn btn--full"
            onClick={handleDiscoverMamaboard}
            disabled={!walletAddressInput.trim() || discoveryLoading}
            style={{ marginBottom: 10 }}
          >
            {discoveryLoading ? `⏳ ${t(lang, 'discovering')}` : `🔍 ${t(lang, 'autoDiscover')}`}
          </button>

          {/* Mamaboard address + read now */}
          <div className="locked-field-label">{t(lang, 'mamaboardLabel')}</div>
          <input
            type="text"
            className="input-field"
            placeholder={t(lang, 'mamaboardPh')}
            value={mamaboardInput}
            onChange={e => persistMamaboard(e.target.value)}
            spellCheck={false}
            style={{ marginBottom: 6 }}
          />
          <button
            className="btn btn--primary btn--full"
            onClick={() => readLockedNow(false)}
            disabled={!mamaboardInput.trim() || lockedReadLoading}
          >
            {lockedReadLoading ? `⏳ ${t(lang, 'reading')}` : `⚡ ${t(lang, 'readNow')}`}
          </button>

          {/* Manual fallback (collapsible) */}
          <button
            className="locked-manual-toggle"
            onClick={() => setShowManualEntry(s => !s)}
          >
            {showManualEntry ? '▼' : '▶'} {t(lang, 'addManual')}
          </button>
          {showManualEntry && (
            <div className="locked-manual-inputs">
              <input
                type="text"
                className="input-field"
                inputMode="decimal"
                placeholder={t(lang, 'manualValuePh')}
                value={newSampleValue}
                onChange={e => setNewSampleValue(e.target.value)}
              />
              <input
                type="text"
                className="input-field"
                placeholder={t(lang, 'manualNotePh')}
                value={newSampleNote}
                onChange={e => setNewSampleNote(e.target.value)}
              />
              <button
                className="btn"
                onClick={handleAddManualSample}
                disabled={!newSampleValue.trim()}
              >
                {t(lang, 'add')}
              </button>
            </div>
          )}

          {/* Samples list */}
          {lockedSamples.length > 0 && (
            <div className="locked-samples-list">
              {lockedSamples.slice(0, 10).map((s, i) => (
                <div key={`${s.timestamp}-${i}`} className="locked-sample-row">
                  <span className={`locked-sample-src locked-sample-src--${s.source}`}>
                    {s.source}
                  </span>
                  <span className="locked-sample-value">{s.value.toFixed(4)}</span>
                  <span className="locked-sample-ts">
                    {new Date(s.timestamp).toLocaleString()}
                    {s.note && ` — ${s.note}`}
                  </span>
                  <button
                    className="locked-sample-del"
                    onClick={() => handleDeleteLockedSample(i)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
                    <span>publicKey</span>
                    <code>{storedKeys.publicKey.substring(0, 16)}…</code>
                  </div>
                  <div className="debug-kv">
                    <span>minerAddress</span>
                    <code className="debug-addr">{storedKeys.minerAddress}</code>
                  </div>
                </div>
              </>
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
