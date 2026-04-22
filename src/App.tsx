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

  // Mining auto-tap loop (fires every TAP_INTERVAL_MS while session active).
  // No external session-end timer: the SDK finalizes at duration_ms on its own.
  const tapTimerRef = useRef<number | null>(null);
  const tapCoordsRef = useRef({ x: 200, y: 200 });
  const tapsCountRef = useRef(0);

  // ═══ Session-loop orchestration (aligned with Mining Hub 1.2.2) ═══
  // Each Start button press begins an "epoch" of up to MAX_SESSIONS_PER_EPOCH
  // sequential 15s sessions. Between sessions we poll canStart() until true,
  // then call startMiningSession() again. get_reward() polls independently
  // every REWARD_POLL_MS while mining is active.
  const shouldAutoRestartRef = useRef(false);
  const sessionCountRef = useRef(0);
  const rejectionCountRef = useRef(0);
  const rewardPollRef = useRef<number | null>(null);
  const canStartTimerRef = useRef<number | null>(null);
  const watchdogRef = useRef<number | null>(null);
  // Bumps on every session (re)start; watchdog/event handlers check their
  // captured generation against this to ignore stale callbacks.
  const sessionGenRef = useRef(0);
  // One-shot signals consumed by the next cooldown computation.
  const queueOverflowRef = useRef(false);
  const minerCorruptedRef = useRef(false);

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

  // ═══ Session-loop helpers ═══

  function stopTapLoop() {
    if (tapTimerRef.current !== null) {
      window.clearInterval(tapTimerRef.current);
      tapTimerRef.current = null;
    }
  }

  function startTapLoop() {
    stopTapLoop();
    tapCoordsRef.current = {
      x: 100 + Math.floor(Math.random() * 200),
      y: 100 + Math.floor(Math.random() * 300),
    };
    tapsCountRef.current = 0;
    setTapsCount(0);

    tapTimerRef.current = window.setInterval(() => {
      const c = tapCoordsRef.current;
      c.x = Math.max(20, Math.min(280, c.x + (Math.random() - 0.5) * 30));
      c.y = Math.max(20, Math.min(380, c.y + (Math.random() - 0.5) * 30));
      const x = Math.floor(c.x);
      const y = Math.floor(c.y);
      if (addTap(x, y)) {
        tapsCountRef.current += 1;
        setTapsCount(tapsCountRef.current);
      }
    }, TAP_INTERVAL_MS);
  }

  function clearWatchdog() {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }

  function clearCanStartTimer() {
    if (canStartTimerRef.current !== null) {
      window.clearTimeout(canStartTimerRef.current);
      canStartTimerRef.current = null;
    }
  }

  function stopRewardPoll() {
    if (rewardPollRef.current !== null) {
      window.clearInterval(rewardPollRef.current);
      rewardPollRef.current = null;
    }
  }

  function startRewardPoll() {
    stopRewardPoll();
    rewardPollRef.current = window.setInterval(() => {
      claimReward()
        .then((ok) => { if (ok) addLog('💰 get_reward() tick'); })
        .catch((e) => addLog(`✗ get_reward: ${e?.message ?? e}`));
    }, REWARD_POLL_MS);
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
    watchdogRef.current = window.setTimeout(() => {
      if (sessionGenRef.current !== genAtStart) return;
      addLog(`⏱ Session ${sessionCountRef.current}: no end event within ${SESSION_WATCHDOG_MS / 1000}s — forcing cooldown-aware next`);
      stopTapLoop();
      scheduleEpochAwareNextSession();
    }, SESSION_WATCHDOG_MS);
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
      canStartTimerRef.current = window.setTimeout(() => {
        tick().catch((e) => addLog(`✗ poll tick error: ${e?.message ?? e}`));
      }, nextMs);
    };

    tick().catch((e) => addLog(`✗ poll tick error: ${e?.message ?? e}`));
  }

  function scheduleNextSession(delayMs = 0) {
    if (!shouldAutoRestartRef.current) return;
    stopTapLoop();
    clearWatchdog();
    clearCanStartTimer();
    if (delayMs > 0) {
      canStartTimerRef.current = window.setTimeout(pollCanStartThenStart, delayMs);
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

  function handleStartMining() {
    if (miningActive) return;
    addLog(`▶ Mining started: ${SESSION_DURATION_MS / 1000}s sessions back-to-back (~${Math.round(SESSION_DURATION_MS / TAP_INTERVAL_MS)} taps each), reward poll every ${REWARD_POLL_MS / 1000}s. Runs until Stop.`);
    shouldAutoRestartRef.current = true;
    sessionCountRef.current = 0;
    rejectionCountRef.current = 0;
    queueOverflowRef.current = false;
    minerCorruptedRef.current = false;
    setSessionCount(0);
    setMiningActive(true);
    setSessionStart(Date.now());
    startRewardPoll();
    startNextSession();
  }

  function handleStopMining() {
    shouldAutoRestartRef.current = false;
    clearAllMiningTimers();
    stopMining();
    setMiningActive(false);
    addLog(`⏹ Stopped. Sessions completed: ${sessionCountRef.current}, taps in last session: ${tapsCountRef.current}`);
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
                Session <strong>#{sessionCount}</strong> · {t(lang, 'sessionTaps')}: <strong>{tapsCount}</strong>
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
