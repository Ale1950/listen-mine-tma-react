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
