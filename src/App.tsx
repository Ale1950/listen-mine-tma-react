import { useState, useEffect, useRef } from 'react';
import { getWalletBalance, type WalletBalance } from './services/blockchain';
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
  claimReward,
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

  // ═══ Mining auth ═══
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [authError, setAuthError] = useState('');
  const [deepLink, setDeepLink] = useState('');
  const [storedKeys, setStoredKeys] = useState<StoredMiningKeys | null>(
    () => loadMiningKeys()
  );

  // ═══ Import keys form ═══
  const [showImportForm, setShowImportForm] = useState(false);
  const [importMinerAddr, setImportMinerAddr] = useState('');
  const [importPublic, setImportPublic] = useState('');
  const [importSecret, setImportSecret] = useState('');
  const [importAppId, setImportAppId] = useState<string>(APP_IDS.batteries);

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
    if (storedKeys?.minerAddress) {
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
      const stored: StoredMiningKeys = {
        walletName: name,
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

      // Refresh balance
      refreshBalance(minerAddress);
    } catch (e: any) {
      setAuthState('error');
      setAuthError(e.message || 'Unknown error');
      addLog(`✗ Auth failed: ${e.message}`);
    }
  }

  // ═══ IMPORT KEYS MODE — bypass the full auth flow ═══
  // Uses pre-existing mining keys extracted from Batteries/Popits via F12 trick.
  // Goes straight to Miner.new() without gen_mining_keys or ensure_mining_keys_propagated.
  async function handleImportKeys() {
    const name = walletNameInput.trim();
    const minerAddr = importMinerAddr.trim();
    const pub = importPublic.trim();
    const sec = importSecret.trim();
    const appId = importAppId;

    if (!name || !minerAddr || !pub || !sec) {
      addLog('✗ Fill all 4 fields: wallet name, miner address, public, secret');
      return;
    }
    if (!minerAddr.startsWith('0:')) {
      addLog('✗ Miner address must start with 0:');
      return;
    }

    localStorage.setItem('lm_wallet_name', name);
    setAuthState('generating');
    addLog(`Importing keys for ${name} (APP_ID=${appId.substring(0, 8)}…${appId.substring(appId.length - 4)})`);

    try {
      await createMiner(minerAddr, pub, sec, appId);
      addLog('✓ Miner instance created with imported keys');

      const stored: StoredMiningKeys = {
        walletName: name,
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
      setImportMinerAddr('');
      setImportPublic('');
      setImportSecret('');

      refreshBalance(minerAddr);
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
    stopMining();
    setMiningActive(false);
    addLog(`Session stopped. Total taps: ${tapsCountRef.current}`);
  }

  async function handleClaim() {
    addLog('Claiming reward…');
    const ok = await claimReward();
    addLog(ok ? '✓ Reward claimed' : '✗ Claim failed');
    if (storedKeys) refreshBalance(storedKeys.minerAddress);
  }

  function handleDisconnectWallet() {
    if (miningActive) handleStopMining();
    clearMiningKeys();
    setStoredKeys(null);
    setWalletBalance(null);
    setWalletNameInput('');
    setAuthState('idle');
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
                  Paste keys extracted from Batteries/Popits via the F12 console trick.
                  Skips the AN Wallet authorization dialog entirely.
                </div>

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
                  placeholder="hex string"
                  value={importPublic}
                  onChange={e => setImportPublic(e.target.value)}
                />

                <label className="import-label">Secret key (stays in your browser)</label>
                <input
                  type="password"
                  className="input-field"
                  placeholder="hex string — never shared"
                  value={importSecret}
                  onChange={e => setImportSecret(e.target.value)}
                />

                <label className="import-label">Source app (determines APP_ID)</label>
                <select
                  className="input-field"
                  value={importAppId}
                  onChange={e => setImportAppId(e.target.value)}
                >
                  <option value={APP_IDS.batteries}>Batteries (0x…0002)</option>
                  <option value={APP_IDS.popits}>Popits (0x…0001)</option>
                </select>

                <button
                  className="btn btn--primary btn--full"
                  onClick={handleImportKeys}
                  disabled={
                    !walletNameInput.trim() ||
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

            <div className="wallet-address">
              {storedKeys.minerAddress.substring(0, 10)}…
              {storedKeys.minerAddress.substring(storedKeys.minerAddress.length - 10)}
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
              {t(lang, 'disconnect')}
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

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {!miningActive ? (
              <button className="btn btn--primary" style={{ flex: 1 }} onClick={handleStartMining}>
                {t(lang, 'startMining')}
              </button>
            ) : (
              <button className="btn" style={{ flex: 1 }} onClick={handleStopMining}>
                {t(lang, 'stopMining')}
              </button>
            )}
            <button className="btn" onClick={handleClaim}>
              {t(lang, 'claim')}
            </button>
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
    </div>
  );
}
