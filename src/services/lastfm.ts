/**
 * ═══ Last.fm Service ═══
 *
 * Polls Last.fm API to detect currently playing tracks.
 * Each new track detection becomes a "tap" for the mining engine.
 */

const LASTFM_API_KEY = '29b7610966e95cd32e80f27f50568f97';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

export interface LastFmTrack {
  artist: string;
  title: string;
  album?: string;
  image?: string;
  nowPlaying: boolean;
  timestamp?: number;
}

export async function getCurrentTrack(username: string): Promise<LastFmTrack | null> {
  try {
    const url = `${LASTFM_BASE}?method=user.getrecenttracks&user=${encodeURIComponent(
      username
    )}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const tracks = data?.recenttracks?.track;
    if (!tracks || tracks.length === 0) return null;

    const t = Array.isArray(tracks) ? tracks[0] : tracks;
    const nowPlaying = t['@attr']?.nowplaying === 'true';

    return {
      artist: t.artist?.['#text'] || '',
      title: t.name || '',
      album: t.album?.['#text'] || '',
      image: t.image?.[2]?.['#text'] || '',
      nowPlaying,
      timestamp: t.date?.uts ? parseInt(t.date.uts) : undefined,
    };
  } catch (e) {
    console.error('Last.fm fetch error:', e);
    return null;
  }
}

export async function validateUser(username: string): Promise<boolean> {
  try {
    const url = `${LASTFM_BASE}?method=user.getinfo&user=${encodeURIComponent(
      username
    )}&api_key=${LASTFM_API_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    return !!data?.user?.name;
  } catch {
    return false;
  }
}

// Track change detector with callback
export class TrackMonitor {
  private username: string;
  private intervalId: number | null = null;
  private lastTrackKey: string = '';
  private onTrackChange: (track: LastFmTrack) => void;

  constructor(username: string, onTrackChange: (track: LastFmTrack) => void) {
    this.username = username;
    this.onTrackChange = onTrackChange;
  }

  start(intervalMs: number = 15000) {
    this.poll();
    this.intervalId = window.setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll() {
    const track = await getCurrentTrack(this.username);
    if (!track) return;

    const key = `${track.artist}::${track.title}`;
    if (key !== this.lastTrackKey && track.nowPlaying) {
      this.lastTrackKey = key;
      this.onTrackChange(track);
    }
  }
}
