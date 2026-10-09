/**
 * Music — two small playlists: the show's lobby and a bed under the match.
 *
 * Deliberately separate from `audio.ts`: that is synthesised SFX owned by the
 * game, this is third-party music with its own licences (see
 * `ASSETS.md`). Keeping them apart means the tracks can be
 * swapped or removed without touching a line of synthesis code.
 *
 * Browsers block audio until a gesture, so nothing plays until `start()` is
 * called from the first click or keypress.
 *
 * - **Lobby** (menus, lobby, results): the broadcast's intro music, full level.
 * - **Live**: a separate match playlist, kept LOW so engines and guns carry the
 *   fight, rising with `setIntensity` as the zone closes, so the endgame plays
 *   like the climax of a broadcast.
 *
 * Plain `<audio>` rather than WebAudio: tracks are long and streaming, the
 * element already handles decode and seeking, and a gain fade is all this needs.
 */

export type Track = {
  src: string;
  title: string;
  artist: string;
  license: string;
  source: string;
};

export type MusicScene = 'lobby' | 'live';

/** Volume in the lobby. */
const LOBBY_VOLUME = 0.4;
/** Match bed at the whistle, and at the final circle. */
const LIVE_VOLUME_MIN = 0.1;
const LIVE_VOLUME_MAX = 0.32;

export class Music {
  private element: HTMLAudioElement | null = null;
  private lists: Record<MusicScene, Track[]> = { lobby: [], live: [] };
  private index: Record<MusicScene, number> = { lobby: 0, live: 0 };
  private scene: MusicScene = 'lobby';
  /** Which list the element is currently playing; lags `scene` during a swap. */
  private playingScene: MusicScene = 'lobby';
  private intensity = 0;
  private muted = false;
  private started = false;
  /**
   * A start was asked for before the playlist finished loading. Browsers only
   * grant audio on a gesture, so a start requested during the fetch MUST be
   * honoured once the element exists — otherwise the one gesture the page got is
   * spent and the music never begins.
   */
  private wantStart = false;
  private targetVolume = 0;
  private fadeTimer: number | null = null;

  get ready(): boolean {
    return this.element !== null && this.lists.lobby.length > 0;
  }

  /** Currently playing track, for a HUD credit line. Null until loaded. */
  get current(): Track | null {
    return this.lists[this.playingScene][this.index[this.playingScene]] ?? null;
  }

  get playing(): boolean {
    return this.started && !this.muted;
  }

  async load(url = '/audio/music/playlist.json'): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as { lobby?: Track[]; match?: Track[] };
      const valid = (list?: Track[]): Track[] =>
        (list ?? []).filter((t) => t && typeof t.src === 'string');
      this.lists = { lobby: valid(data.lobby), live: valid(data.match) };
      // A match list is optional: without one the lobby list plays under it.
      if (this.lists.live.length === 0) this.lists.live = this.lists.lobby;
      if (this.lists.lobby.length === 0) return;

      const element = new Audio();
      element.preload = 'auto';
      element.loop = false;
      element.volume = 0; // the fade brings it in
      element.src = this.lists.lobby[0].src;
      element.addEventListener('ended', () => this.next());
      this.element = element;
      // Honour a start that came in while we were still fetching.
      if (this.wantStart) this.start();
    } catch {
      // No music is not a failure; the game runs without it.
      this.element = null;
    }
  }

  /** Begin playback. Must be called from a user gesture. Idempotent. */
  start(): void {
    this.wantStart = true;
    if (this.started || !this.element) return;
    this.started = true;
    void this.element.play().catch(() => {
      // Blocked (no gesture, or a policy) — allow a later attempt.
      this.started = false;
    });
    this.applyVolume();
  }

  /** Enable or mute the music, independent of the game's SFX. */
  setEnabled(on: boolean): void {
    this.muted = !on;
    this.applyVolume();
  }

  stop(): void {
    this.element?.pause();
    this.started = false;
  }

  /** Lobby or live. A change fades out, swaps playlist, and fades back in. */
  setScene(scene: MusicScene): void {
    if (scene === this.scene) return;
    this.scene = scene;
    this.applyVolume();
  }

  /** 0 at the whistle, 1 at the final circle. Only heard while live. */
  setIntensity(value: number): void {
    const v = Math.min(1, Math.max(0, value));
    if (Math.abs(v - this.intensity) < 0.02) return;
    this.intensity = v;
    this.applyVolume();
  }

  toggle(): boolean {
    this.muted = !this.muted;
    this.applyVolume();
    return !this.muted;
  }

  private next(): void {
    const element = this.element;
    const list = this.lists[this.playingScene];
    if (!element || list.length === 0) return;
    this.index[this.playingScene] = (this.index[this.playingScene] + 1) % list.length;
    element.src = list[this.index[this.playingScene]].src;
    if (this.started) void element.play().catch(() => {});
  }

  /** Point the element at the current scene's playlist, at its next track. */
  private swapToScene(): void {
    const element = this.element;
    if (!element || this.playingScene === this.scene) return;
    // Advance the outgoing list so a return to it does not replay the same cue.
    const out = this.lists[this.playingScene];
    if (out.length > 0) this.index[this.playingScene] = (this.index[this.playingScene] + 1) % out.length;
    this.playingScene = this.scene;
    const list = this.lists[this.scene];
    element.src = list[this.index[this.scene] % list.length].src;
    if (this.started) void element.play().catch(() => {});
  }

  private sceneVolume(): number {
    if (this.muted) return 0;
    if (this.scene === 'lobby') return LOBBY_VOLUME;
    return LIVE_VOLUME_MIN + (LIVE_VOLUME_MAX - LIVE_VOLUME_MIN) * this.intensity;
  }

  /**
   * Fade toward the target, ~1 s. If the scene changed, fade OUT first, swap
   * the playlist at silence, then fade into the new scene's level.
   */
  private applyVolume(): void {
    const element = this.element;
    if (!element) return;
    if (this.fadeTimer !== null) return; // the running fade re-reads the target

    this.fadeTimer = window.setInterval(() => {
      const swapping = this.playingScene !== this.scene;
      this.targetVolume = swapping ? 0 : this.sceneVolume();
      const current = element.volume;
      const diff = this.targetVolume - current;
      if (Math.abs(diff) < 0.01) {
        element.volume = this.targetVolume;
        if (swapping) {
          this.swapToScene();
          return; // keep the timer running to fade the new list in
        }
        if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        return;
      }
      element.volume = Math.min(1, Math.max(0, current + Math.sign(diff) * 0.03));
    }, 30);
  }
}
