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
  canStartMining,
  claimReward,
  reinitMiner,
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
import { MusicVisualizer } from './components/MusicVisualizer';
import { miningTimers } from './utils/miningTimers';
import { startSilentKeepAlive, stopSilentKeepAlive, registerKeepAliveSw } from './utils/keepAlive';

type AuthState = 'idle' | 'generating' | 'awaiting' | 'propagating' | 'ready' | 'error';

// ═══ Mining flow constants (aligned with Mining Hub 1.2.2) ═══
// Each Miner.start(duration_ms, cb) call is a short 15s micro-session.
// The SDK's internal timer finalises the session at duration_ms and emits
// submit_session_root / session_accepted / finished events.
const SESSION_DURATION_MS = 15_000;

// Listen & Mine is a music app, not a clicker. 8 taps in a 15s session is
// plenty to witness the Merkle tree and pass the on-chain threshold.
// 15000 / 8 = 1875ms.
const TAP_INTERVAL_MS = 1_875;

// Epoch loop runs forever while the user is mining. Counter is for display.
// (Mining Hub's xa=10 cap is intentionally NOT applied here — the user wants
// mining to continue as long as music is playing.)

// Independent get_reward() polling cadence while mining is active (Mining Hub
// X2 = 15_000). The SDK submits session data on its own, but an explicit
// get_reward() is what actually transfers NACKL to the miner contract.
const REWARD_POLL_MS = 15_000;

// Exponential backoff on submit_session_root errors: 5s, 10s, 20s, 40s, cap 120s.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 120_000;

// Post-submit minimum cooldown: ALWAYS wait this long between sessions even
// on the happy path. Mining Hub doesn't submit back-to-back — spacing protects
// the blockchain from QUEUE_OVERFLOW + "server response: 502" errors we saw
// echoed in the AN Wallet panel.
const POST_SUBMIT_COOLDOWN_MS = 5_000;

// Epoch boundary: after N sequential sessions, pause for a longer cooldown so
// the chain can digest submissions. Mirrors Mining Hub's Gp=60_000 after xa=10.
const SESSIONS_PER_EPOCH = 10;
const EPOCH_COOLDOWN_MS = 60_000;

// Specific error backoffs.
const QUEUE_OVERFLOW_COOLDOWN_MS = 30_000;
const MINER_CORRUPTED_COOLDOWN_MS = 15_000;

// Auto-refresh cadences — kept deliberately low-frequency to save bandwidth
// and respect on-chain read limits.
const WALLET_REFRESH_MS = 60_000;        // 4 boxes: NACKL free / SHELL / USDC / Locked
const NACKL_EARN_REFRESH_MS = 330_000;   // 24h earnings + last session delta
const SESSION_GAIN_DELAY_MS = 8_000;     // wait this long after session_accepted to read locked
const LOCKED_HISTORY_24H_MS = 24 * 3_600_000;

// Gap between sessions: poll can_start() every 1s for the first "quick" window,
// then fall back to a slow 30s retry so we don't hammer the SDK while the
// network settles. The loop never gives up — only handleStopMining() does.
const CANSTART_POLL_MS = 1_000;
const CANSTART_SLOW_MS = 30_000;
const CANSTART_QUICK_WINDOW_MS = 18_000;

// While stuck on can_start()=false, call reinitMiner() at this cadence. Mining
// Hub does this when its SDK session is "stale": the miner's internal state is
// reset by destroying + recreating the Miner instance with the same keys.
const REINIT_INTERVAL_MS = 60_000;

// Safety watchdog: if no progress event arrives within this window, force the
// session loop to move on anyway. Session + 18s buffer.
const SESSION_WATCHDOG_MS = SESSION_DURATION_MS + 18_000;

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

  // Mining auto-tap loop. Timer lives in a Web Worker — main thread only
  // holds a coord drift buffer + running tap counter.
  const tapCoordsRef = useRef({ x: 200, y: 200 });
  const tapsCountRef = useRef(0);

  // ═══ Session-loop orchestration (aligned with Mining Hub 1.2.2) ═══
  // Mining runs forever while music is playing. All timers (tap, reward,
  // canStart, watchdog) are scheduled via miningTimers → Web Worker, so
  // they don't get throttled when the tab is hidden.
  const shouldAutoRestartRef = useRef(false);
  const sessionCountRef = useRef(0);
  const rejectionCountRef = useRef(0);
  // Bumps on every session (re)start; watchdog/event handlers check their
  // captured generation against this to ignore stale callbacks.
  const sessionGenRef = useRef(0);
  // One-shot signals consumed by the next cooldown computation.
  const queueOverflowRef = useRef(false);
  const minerCorruptedRef = useRef(false);

  // Session-gain tracking: capture Locked value before each session, compare
  // after session_accepted (with a small delay so chain can settle).
  const lockedBeforeSessionRef = useRef<number | null>(null);
  const [lastSessionGain, setLastSessionGain] = useState<number | null>(null);
  const [lastSessionGainAt, setLastSessionGainAt] = useState<number | null>(null);

  // Visualiser triggers (parent increments counters; child animates)
  const [tapPulseCounter, setTapPulseCounter] = useState(0);
  const [trackChangeCounter, setTrackChangeCounter] = useState(0);

  // Auto-refresh bookkeeping (for the "fresh" dot blink)
  const [walletRefreshAt, setWalletRefreshAt] = useState<number | null>(null);
  const [walletJustRefreshed, setWalletJustRefreshed] = useState(false);
  const [lockedRefreshAt, setLockedRefreshAt] = useState<number | null>(null);

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
  const [sessionCount, setSessionCount] = useState(0);
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
      setTrackChangeCounter((n) => n + 1);
      addLog(`♪ ${track.artist} — ${track.title}`);
    });
    monitor.start(15000);
    trackMonitorRef.current = monitor;
    return () => {
      monitor.stop();
      trackMonitorRef.current = null;
    };
  }, [lastfmUser]);

  // ═══ Auto-mining — follows Last.fm playback ═══
  // 100% automatic: music plays → mining starts; music stops → mining pauses.
  // No manual Start/Stop button.
  useEffect(() => {
    const isReadyNow = authState === 'ready' && !!storedKeys;
    if (!isReadyNow) return;
    if (!lastfmUser) return;

    if (currentTrack && !miningActive) {
      addLog(`🎵 Music playing — auto-starting mining`);
      handleStartMining();
    } else if (!currentTrack && miningActive) {
      addLog('🔇 No music — auto-pausing mining');
      handleStopMining();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack, authState, storedKeys, lastfmUser]);

  // ═══ Background keep-alive (register SW + log visibility changes) ═══
  useEffect(() => {
    void registerKeepAliveSw();
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        addLog('⚡ Tab hidden — mining continues via Web Worker + silent audio');
      } else {
        addLog('👁 Tab visible again');
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep-alive audio tracks mining state (redundant safety — handleStart/Stop
  // already call these, but this guarantees consistency on unmount).
  useEffect(() => {
    if (miningActive) startSilentKeepAlive();
    else stopSilentKeepAlive();
  }, [miningActive]);

  // ═══ Wallet balance refresh ═══
  async function refreshBalance(address: string, silent = false) {
    if (!silent) setWalletLoading(true);
    try {
      const bal = await getWalletBalance(address);
      setWalletBalance(bal);
      setWalletRefreshAt(Date.now());
      setWalletJustRefreshed(true);
      window.setTimeout(() => setWalletJustRefreshed(false), 900);
      if (!silent) {
        if (bal.found) addLog(`Balance loaded from ${bal.network}`);
        else addLog(`Wallet not found: ${bal.error}`);
      }
    } catch (e: any) {
      if (!silent) addLog(`Balance error: ${e.message}`);
    } finally {
      if (!silent) setWalletLoading(false);
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
    const name = walletNameInput.trim().toLowerCase();
    if (!name) {
      addLog('Enter wallet name first');
      return;
    }
    localStorage.setItem('lm_wallet_name', name);
    // Reflect the normalised value back in the input for clarity.
    setWalletNameInput(name);

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

  // ═══ Session-loop helpers ═══

  function stopTapLoop() {
    miningTimers.clear('tap');
  }

  function startTapLoop() {
    stopTapLoop();
    tapCoordsRef.current = {
      x: 100 + Math.floor(Math.random() * 200),
      y: 100 + Math.floor(Math.random() * 300),
    };
    tapsCountRef.current = 0;
    setTapsCount(0);

    miningTimers.setInterval('tap', TAP_INTERVAL_MS, () => {
      const c = tapCoordsRef.current;
      c.x = Math.max(20, Math.min(280, c.x + (Math.random() - 0.5) * 30));
      c.y = Math.max(20, Math.min(380, c.y + (Math.random() - 0.5) * 30));
      const x = Math.floor(c.x);
      const y = Math.floor(c.y);
      if (addTap(x, y)) {
        tapsCountRef.current += 1;
        setTapsCount(tapsCountRef.current);
        setTapPulseCounter((n) => n + 1);
      }
    });
  }

  function clearWatchdog() {
    miningTimers.clear('watchdog');
  }

  function clearCanStartTimer() {
    miningTimers.clear('canstart');
  }

  function stopRewardPoll() {
    miningTimers.clear('reward');
  }

  function startRewardPoll() {
    stopRewardPoll();
    miningTimers.setInterval('reward', REWARD_POLL_MS, () => {
      claimReward()
        .then((ok) => { if (ok) addLog('💰 get_reward() tick'); })
        .catch((e) => addLog(`✗ get_reward: ${e?.message ?? e}`));
    });
  }

  function clearAllMiningTimers() {
    stopTapLoop();
    clearWatchdog();
    clearCanStartTimer();
    stopRewardPoll();
  }

  // Parse SDK event: shape varies across Bee SDK versions. Pull kind/data/error
  // from whatever path is present.
  function parseSdkEvent(event: any): { kind: string; data: any; error?: string } {
    if (typeof event === 'string') return { kind: event, data: null };
    const e = event ?? {};
    const kind = (e.action ?? e.type ?? e.event ?? 'unknown') as string;
    const data = e.data ?? e.payload ?? null;
    let error: string | undefined;
    if (typeof e.error === 'string') error = e.error;
    else if (data && typeof data === 'object' && typeof data.error === 'string') error = data.error;
    return { kind, data, error };
  }

  function startNextSession() {
    stopTapLoop();
    clearWatchdog();

    if (!shouldAutoRestartRef.current) return;

    if (!canStartMining()) {
      pollCanStartThenStart();
      return;
    }

    const genAtStart = ++sessionGenRef.current;
    sessionCountRef.current += 1;
    setSessionCount(sessionCountRef.current);
    // Capture current Locked NACKL so we can compute per-session delta on
    // session_accepted (if known; otherwise the first accepted session will
    // set the baseline and subsequent ones will show a real delta).
    if (lockedBeforeSessionRef.current === null && lockedSamples.length > 0) {
      lockedBeforeSessionRef.current = lockedSamples[0].value;
    }
    addLog(`▶ Session ${sessionCountRef.current}: start (${SESSION_DURATION_MS / 1000}s, tap every ${(TAP_INTERVAL_MS / 1000).toFixed(2)}s → ~${Math.round(SESSION_DURATION_MS / TAP_INTERVAL_MS)} taps)…`);

    const ok = startMiningSession(SESSION_DURATION_MS, (event) => handleSdkEvent(event, genAtStart));
    if (!ok) {
      addLog('✗ startMiningSession returned false — retrying after short delay');
      sessionCountRef.current -= 1;
      setSessionCount(sessionCountRef.current);
      scheduleNextSession(BACKOFF_BASE_MS);
      return;
    }

    setSessionStart(Date.now());
    startTapLoop();

    // Safety watchdog — ignored if generation already advanced.
    miningTimers.setTimeout('watchdog', SESSION_WATCHDOG_MS, () => {
      if (sessionGenRef.current !== genAtStart) return;
      addLog(`⏱ Session ${sessionCountRef.current}: no end event within ${SESSION_WATCHDOG_MS / 1000}s — forcing cooldown-aware next`);
      stopTapLoop();
      scheduleEpochAwareNextSession();
    });
  }

  async function attemptReinit(): Promise<boolean> {
    if (!storedKeys) return false;
    addLog('🔄 Reinit Miner (destroy + Miner.new with same keys)…');
    try {
      const ok = await reinitMiner(
        storedKeys.minerAddress,
        storedKeys.publicKey,
        storedKeys.secretKey,
      );
      if (ok) {
        addLog('✓ Miner reinit OK');
        rejectionCountRef.current = 0;
      } else {
        addLog('✗ Miner reinit returned false');
      }
      return ok;
    } catch (e: any) {
      addLog(`✗ Miner reinit error: ${e?.message ?? e}`);
      return false;
    }
  }

  function pollCanStartThenStart() {
    clearCanStartTimer();
    const startedAt = Date.now();
    let lastReinitAt = 0;
    let slowLogged = false;

    const tick = async () => {
      if (!shouldAutoRestartRef.current) return;
      if (canStartMining()) {
        startNextSession();
        return;
      }
      const elapsed = Date.now() - startedAt;
      const isSlow = elapsed > CANSTART_QUICK_WINDOW_MS;

      // Trigger Miner reinit after the 18s quick window expires, then every
      // REINIT_INTERVAL_MS while stuck. Mirrors Mining Hub 1.2.2 handling of
      // "stale SDK session" — a fresh Miner.new() clears internal state that
      // keeps can_start() returning false across sessions.
      const shouldReinit =
        isSlow && (lastReinitAt === 0 || Date.now() - lastReinitAt >= REINIT_INTERVAL_MS);

      if (shouldReinit) {
        lastReinitAt = Date.now();
        const ok = await attemptReinit();
        if (!shouldAutoRestartRef.current) return;
        if (ok && canStartMining()) {
          startNextSession();
          return;
        }
      }

      if (isSlow && !slowLogged) {
        slowLogged = true;
        addLog(`⏳ canStart()=false after ${Math.round(elapsed / 1000)}s — slow retry every ${CANSTART_SLOW_MS / 1000}s, reinit every ${REINIT_INTERVAL_MS / 1000}s (loop runs until Stop)`);
      }

      const nextMs = isSlow ? CANSTART_SLOW_MS : CANSTART_POLL_MS;
      miningTimers.setTimeout('canstart', nextMs, () => {
        tick().catch((e) => addLog(`✗ poll tick error: ${e?.message ?? e}`));
      });
    };

    tick().catch((e) => addLog(`✗ poll tick error: ${e?.message ?? e}`));
  }

  function scheduleNextSession(delayMs = 0) {
    if (!shouldAutoRestartRef.current) return;
    stopTapLoop();
    clearWatchdog();
    clearCanStartTimer();
    if (delayMs > 0) {
      miningTimers.setTimeout('canstart', delayMs, pollCanStartThenStart);
    } else {
      pollCanStartThenStart();
    }
  }

  // Compute the right cooldown based on flags set during the session's SDK
  // events, then schedule the next session. This is the ONLY entry point for
  // "session ended, plan the next one" — `finished`/`removed` events and the
  // safety watchdog both call it.
  function scheduleEpochAwareNextSession() {
    if (!shouldAutoRestartRef.current) return;

    let delayMs = POST_SUBMIT_COOLDOWN_MS;
    let reason = 'post-submit cooldown';
    let needsReinit = false;

    if (minerCorruptedRef.current) {
      minerCorruptedRef.current = false;
      delayMs = MINER_CORRUPTED_COOLDOWN_MS;
      reason = 'miner_state_corrupted — reinit + wait';
      needsReinit = true;
    } else if (queueOverflowRef.current) {
      queueOverflowRef.current = false;
      delayMs = QUEUE_OVERFLOW_COOLDOWN_MS;
      reason = 'QUEUE_OVERFLOW — message queue full';
    } else if (rejectionCountRef.current >= 2) {
      const n = rejectionCountRef.current;
      delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, n - 1), BACKOFF_MAX_MS);
      reason = `${n} consecutive submit failures — exp backoff`;
    } else if (
      sessionCountRef.current > 0 &&
      sessionCountRef.current % SESSIONS_PER_EPOCH === 0
    ) {
      delayMs = EPOCH_COOLDOWN_MS;
      reason = `epoch ${sessionCountRef.current / SESSIONS_PER_EPOCH} complete (${SESSIONS_PER_EPOCH} sessions)`;
    }

    addLog(`⏸ Cooldown ${(delayMs / 1000).toFixed(0)}s — ${reason}`);

    if (needsReinit) {
      void (async () => {
        await attemptReinit();
        scheduleNextSession(delayMs);
      })();
    } else {
      scheduleNextSession(delayMs);
    }
  }

  function detectFailureSignals(event: any, error: string | undefined) {
    const errTxt = (error || '').toLowerCase();
    if (errTxt.includes('queue_overflow') || errTxt.includes('message queue is full')) {
      queueOverflowRef.current = true;
    }
    const corrupted =
      event?.data?.miner_state_corrupted === true ||
      event?.miner_state_corrupted === true ||
      (typeof event === 'object' &&
        event !== null &&
        (event.action === 'miner_state_corrupted' || event.type === 'miner_state_corrupted'));
    if (corrupted) minerCorruptedRef.current = true;
  }

  function handleSdkEvent(event: any, gen: number) {
    // Ignore stale events (from a session that's already been replaced).
    if (gen !== sessionGenRef.current) return;

    const { kind, data, error } = parseSdkEvent(event);
    addLog(`📡 SDK: ${kind}${error ? ` ERROR="${error}"` : ''}`);
    detectFailureSignals(event, error);

    if (kind === 'submit_session_root') {
      if (error) {
        rejectionCountRef.current += 1;
        addLog(`⚠️ submit_session_root FAILED (#${rejectionCountRef.current}) — waiting for session end to apply cooldown`);
      }
      // Don't schedule here — the cooldown decision happens at session end.
      return;
    }

    if (kind === 'session_accepted') {
      rejectionCountRef.current = 0;
      addLog('✓ session_accepted by network');
      // Schedule a delayed Locked read so chain can settle, then compute delta.
      const before = lockedBeforeSessionRef.current;
      const popit = mamaboardInput.trim();
      if (popit) {
        window.setTimeout(async () => {
          try {
            const after = await getLockedNackl(popit);
            if (before !== null) {
              const gain = after.nackl - before;
              setLastSessionGain(gain);
              setLastSessionGainAt(Date.now());
              addLog(`💎 Session gain: ${gain >= 0 ? '+' : ''}${gain.toFixed(4)} NACKL`);
            }
            lockedBeforeSessionRef.current = after.nackl;
            // Keep the locked-samples history up to date
            setLockedSamples((prev) => {
              const latest = prev[0];
              if (latest && latest.value === after.nackl) return prev;
              const sample: LockedSample = {
                value: after.nackl,
                timestamp: after.timestamp,
                source: 'auto',
              };
              const next: LockedSample[] = [sample, ...prev].slice(0, 200);
              localStorage.setItem(LOCKED_SAMPLES_KEY, JSON.stringify(next));
              return next;
            });
            setLockedRefreshAt(Date.now());
          } catch (e: any) {
            addLog(`✗ post-session locked read failed: ${e?.message ?? e}`);
          }
        }, SESSION_GAIN_DELAY_MS);
      }
      return;
    }

    if (kind === 'status_updated') {
      const status = (data && typeof data === 'object' ? data.status : '') as string;
      if (status === 'finished' || status === 'removed') {
        addLog(`🔚 Session ${sessionCountRef.current} ended (${status})`);
        scheduleEpochAwareNextSession();
      }
      return;
    }

    if (kind === 'finished' || kind === 'removed') {
      addLog(`🔚 Session ${sessionCountRef.current} ended (${kind})`);
      scheduleEpochAwareNextSession();
    }
  }

  // Auto-mining ONLY. No manual Start/Stop — the useEffect watching
  // currentTrack calls these directly.
  function handleStartMining() {
    if (miningActive) return;
    addLog(`▶ Mining started: ${SESSION_DURATION_MS / 1000}s sessions back-to-back (~${Math.round(SESSION_DURATION_MS / TAP_INTERVAL_MS)} taps each), reward poll every ${REWARD_POLL_MS / 1000}s.`);
    shouldAutoRestartRef.current = true;
    sessionCountRef.current = 0;
    rejectionCountRef.current = 0;
    queueOverflowRef.current = false;
    minerCorruptedRef.current = false;
    setSessionCount(0);
    setMiningActive(true);
    setSessionStart(Date.now());
    startSilentKeepAlive();
    startRewardPoll();
    startNextSession();
  }

  function handleStopMining() {
    shouldAutoRestartRef.current = false;
    clearAllMiningTimers();
    stopMining();
    stopSilentKeepAlive();
    setMiningActive(false);
    addLog(`⏸ Auto-paused (music stopped). Sessions: ${sessionCountRef.current}`);
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
      setLockedRefreshAt(Date.now());
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
        const next: LockedSample[] = [autoSample, ...prev].slice(0, 200);
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

  // 24h earnings: find the newest sample with ts ≤ (now - 24h), compute
  // latest - that. If no sample is old enough, fall back to the oldest
  // available and annotate the window duration so the user knows it's partial.
  const earn24h = (() => {
    if (lockedSamples.length < 2) return null;
    const latest = lockedSamples[0];
    const cutoff = Date.now() - LOCKED_HISTORY_24H_MS;
    // lockedSamples[0] is newest, so iterate from newest to oldest and pick
    // the first sample past the cutoff.
    let anchor = lockedSamples[lockedSamples.length - 1];
    for (const s of lockedSamples) {
      if (s.timestamp <= cutoff) { anchor = s; break; }
    }
    const full = anchor.timestamp <= cutoff;
    const delta = latest.value - anchor.value;
    const spanMs = latest.timestamp - anchor.timestamp;
    return { delta, spanMs, full };
  })();

  function formatLockedDuration(ms: number): string {
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  // ═══ Auto-refresh cadences ═══
  // Wallet balance: every 60s while a wallet is connected.
  useEffect(() => {
    if (!storedKeys) return;
    refreshBalance(storedKeys.minerAddress, true);
    const id = window.setInterval(
      () => { refreshBalance(storedKeys.minerAddress, true); },
      WALLET_REFRESH_MS,
    );
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKeys]);

  // NACKL Locked earnings: refresh every 330s (not real-time — chain settle time)
  useEffect(() => {
    if (!mamaboardInput.trim()) return;
    readLockedNow(true);
    const id = window.setInterval(() => { readLockedNow(true); }, NACKL_EARN_REFRESH_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mamaboardInput]);

  // Auto-discover Popit Game contract when the wallet address is known and
  // we don't have one yet. Runs once per wallet-address change.
  useEffect(() => {
    const wallet = walletAddressInput.trim();
    if (!wallet) return;
    if (mamaboardInput.trim()) return;       // already have one
    if (discoveryLoading) return;
    handleDiscoverMamaboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddressInput]);

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

      {/* ═══ MUSIC VISUALIZER ═══ */}
      <MusicVisualizer
        playing={!!currentTrack}
        tapPulse={tapPulseCounter}
        trackChange={trackChangeCounter}
      />

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
              <>
                <div className="wallet-grid__head">
                  <span style={{ fontSize: 10, letterSpacing: 1.2, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
                    {walletBalance.network}
                  </span>
                  <span className={`refresh-ind ${walletJustRefreshed ? 'refresh-ind--fresh' : ''}`}>
                    <span className="refresh-ind__dot" />
                    {walletRefreshAt
                      ? `${Math.max(0, Math.round((Date.now() - walletRefreshAt) / 1000))}s ago`
                      : '—'}
                  </span>
                </div>
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
                    <div className="wallet-stat__label">NACKL LOCKED</div>
                    <div className="wallet-stat__value">
                      {lockedSamples.length > 0
                        ? lockedSamples[0].value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : '—'}
                    </div>
                  </div>
                </div>
              </>
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

      {/* ═══ NACKL EARNINGS (simplified) ═══ */}
      {storedKeys && (
        <div className="card">
          <div className="card__label">💎 NACKL Earnings</div>

          <div className="earn-grid">
            <div
              className={`earn-stat ${earn24h && earn24h.delta > 0 ? 'earn-stat--gained' : ''}`}
            >
              <div className="earn-stat__label">Last 24h</div>
              {earn24h ? (
                <>
                  <div className={`earn-stat__value ${earn24h.delta > 0 ? 'earn-stat__value--pos' : earn24h.delta < 0 ? 'earn-stat__value--neg' : ''}`}>
                    {earn24h.delta >= 0 ? '+' : ''}{earn24h.delta.toFixed(4)}
                  </div>
                  <div className="earn-stat__sub">
                    {earn24h.full
                      ? 'NACKL in 24h'
                      : `partial window · ${formatLockedDuration(earn24h.spanMs)}`}
                  </div>
                </>
              ) : (
                <>
                  <div className="earn-stat__value earn-stat__value--dim">—</div>
                  <div className="earn-stat__sub">need more history</div>
                </>
              )}
            </div>

            <div
              className={`earn-stat ${lastSessionGain !== null && lastSessionGain > 0 ? 'earn-stat--gained earn-stat--new' : ''}`}
              key={`session-${lastSessionGainAt ?? 0}`}
            >
              <div className="earn-stat__label">Last session</div>
              {lastSessionGain !== null ? (
                <>
                  <div className={`earn-stat__value ${lastSessionGain > 0 ? 'earn-stat__value--pos' : lastSessionGain < 0 ? 'earn-stat__value--neg' : ''}`}>
                    {lastSessionGain >= 0 ? '+' : ''}{lastSessionGain.toFixed(4)}
                  </div>
                  <div className="earn-stat__sub">
                    {lastSessionGainAt
                      ? `${Math.max(0, Math.round((Date.now() - lastSessionGainAt) / 60_000))}m ago`
                      : 'just now'}
                  </div>
                </>
              ) : (
                <>
                  <div className="earn-stat__value earn-stat__value--dim">—</div>
                  <div className="earn-stat__sub">waiting for a session</div>
                </>
              )}
            </div>
          </div>

          {/* Wallet address (auto-discovers Popit Game contract on paste) */}
          <div className="locked-field-label" style={{ marginTop: 16 }}>
            Your AN Wallet address
          </div>
          <input
            type="text"
            className="input-field"
            placeholder="0:… paste your wallet address"
            value={walletAddressInput}
            onChange={e => persistWalletAddress(e.target.value)}
            spellCheck={false}
          />

          {/* Popit Game address — auto-filled, editable as fallback */}
          <div className="locked-field-label" style={{ marginTop: 10 }}>
            Popit Game contract
            {discoveryLoading && <span style={{ marginLeft: 8, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>· discovering…</span>}
          </div>
          <input
            type="text"
            className="input-field"
            placeholder="auto-detected from wallet — or paste manually"
            value={mamaboardInput}
            onChange={e => persistMamaboard(e.target.value)}
            spellCheck={false}
          />

          <div className="earn-footer">
            <span>
              {lockedRefreshAt
                ? `updated ${Math.max(0, Math.round((Date.now() - lockedRefreshAt) / 1000))}s ago`
                : 'waiting for first read'}
              {mamaboardInput.trim() && ' · refresh every 330s'}
            </span>
            <button
              className="earn-popit"
              onClick={() => readLockedNow(false)}
              disabled={!mamaboardInput.trim() || lockedReadLoading}
              title="Read Locked NACKL now"
            >
              {lockedReadLoading ? '…' : '↻ refresh'}
            </button>
          </div>
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

      {/* ═══ MINING STATUS CARD (fully automatic) ═══ */}
      {isReady && lastfmUser && (
        <div className={`card ${miningActive ? 'card--mining' : ''}`}>
          <div className="card__label">{t(lang, 'miningStatus')}</div>

          {/* Auto / waiting mode indicator */}
          <div
            className={`mine-mode ${miningActive ? 'mine-mode--active' : 'mine-mode--waiting'}`}
            style={{ marginBottom: 10 }}
          >
            <span className="mine-mode__dot" />
            {miningActive && currentTrack
              ? `🎵 Mining active — ${currentTrack.title} · ${currentTrack.artist}`
              : miningActive
                ? '🎵 Mining active'
                : '⏸ Waiting for music…'}
          </div>

          {miningActive && (
            <div className="mining-status">
              <span className="badge badge--success">▶ {t(lang, 'mining')}</span>
              <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
                Session <strong>#{sessionCount}</strong> · {t(lang, 'sessionTaps')}: <strong>{tapsCount}</strong>
              </span>
            </div>
          )}

          <div className="mining-info">
            ℹ️ Mining is fully automatic — it starts when Last.fm detects music and pauses when the music stops.
            Rewards land in your wallet after sessions settle on-chain. Keep this tab open for best results.
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
            <div className="debug-note">
              <span className="debug-note__icon">ℹ️</span>
              <div>
                <div className="debug-note__title">AN Wallet errors are NOT related to Listen &amp; Mine</div>
                <div className="debug-note__text">
                  If the AN Wallet app shows messages like <code>query_active_sessions_by_multifactor failed</code>, <code>query_profiles_by_multifactor</code>, or <code>server response: error code: 502</code>, those are internal AN Wallet errors. They do not affect mining in Listen &amp; Mine — ignore them here.
                </div>
              </div>
            </div>
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
