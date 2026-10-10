/**
 * HUD binding. Deliberately thin: it reads simulation read-outs and writes DOM.
 *
 * DESIGN.md §8 specifies hull and per-component status for the real game; at M1
 * there is only one car and nothing shooting at it, so this shows exactly what
 * matters for tuning handling: speed, whether the car is grounded, boost, and
 * an FPS read-out so we can see the cost of the simulation.
 */

import { COMBAT, NET, VEHICLE } from '../shared/config';
import { integrity, wheelIntegrity, type Components } from '../shared/components';
import type { VehicleState } from '../shared/vehicle';
import type { MatchSnapshot } from '../shared/match';
import type { ZoneState } from '../shared/zone';
import type { BoardRow } from '../shared/protocol';
import type { CreditsSection } from '../shared/credits';

/**
 * Paint a component pip: how much is left, and a colour that says so.
 *
 * Amber past half, red past a quarter. The number matters less than the trend —
 * a glance should tell you whether you still have an engine.
 */
function setPip(el: HTMLElement, fraction: number): void {
  el.style.setProperty('--health', `${Math.round(clamp01(fraction) * 100)}%`);
  const colour = fraction > 0.5 ? 'var(--accent)' : fraction > 0.25 ? '#ffb020' : '#e5484d';
  el.style.setProperty('--pip-colour', colour);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Milliseconds as `m:ss`. Used for the match clock. */
function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`HUD element #${id} missing`);
  return el as T;
};

export class Hud {
  private speedValue = byId('speed-value');
  private tState = byId('t-state');
  private tStatus = byId('t-status');
  private tPlayers = byId('t-players');
  private tPing = byId('t-ping');
  private tJitter = byId('t-jitter');
  private tLatency = byId('t-latency');
  private cWeapon = byId('c-weapon');
  private cAmmo = byId('c-ammo');
  private cAmmoFill = byId('c-ammo-fill');
  private cHealth = byId('c-health');
  private cHull = byId('c-hull');
  private cHullFill = byId('c-hull-fill');
  private cHealthRow = byId('c-health-row');
  private controls = byId('controls');
  private hitmarker = byId('hitmarker');
  private crosshair = byId('crosshair');
  private cEngine = byId('c-engine');
  private cRepairing = byId('c-repairing');
  private cTyres = byId('c-tyres');
  private hitmarkerTimer = 0;
  private cKey = byId('c-key');
  private cWeapon2Row = byId('c-weapon2-row');
  private cWeapon2 = byId('c-weapon2');
  private cAmmo2 = byId('c-ammo2');
  private cAmmo2Fill = byId('c-ammo2-fill');
  private reticles = [byId('reticle-0'), byId('reticle-1')];
  private killConfirm = byId('killconfirm');
  private hitFlash = byId('hitflash');
  private hitFlashLevel = 0;
  private hullBar = byId('c-hull-fill');
  private killConfirmTimer = 0;
  private hitDirTimer = 0;
  private tWorld = byId('t-world');
  private tFps = byId('t-fps');
  private boostFill = byId('boost-fill');
  private boostPct = byId('boost-pct');
  private prompt = byId('prompt');

  // ---- match flow (DESIGN.md §2.1) ----
  private scoreboard = byId('scoreboard');
  private team0 = byId('s-team0');
  private team1 = byId('s-team1');
  private tag0 = byId('s-tag0');
  private tag1 = byId('s-tag1');
  private score0 = byId('s-score0');
  private score1 = byId('s-score1');
  private clock = byId('s-clock');
  private banner = byId('banner');
  private bannerTitle = byId('banner-title');
  private bannerSub = byId('banner-sub');
  private bannerButton = byId<HTMLButtonElement>('banner-button');

  // ---- closing zone ----
  private zonePanel = byId('zone');
  private outsideVignette = byId('outside');

  // ---- damage feedback ----
  private hurt = byId('hurt');
  private hitDir = byId('hitdir');

  // ---- kill feed ----
  private killfeed = byId('killfeed');

  // ---- results board ----
  private board = byId('board');

  // ---- damage numbers & first-match tips ----
  private damageLayer = byId('damage');
  private tip = byId('tip');
  private tipTimer = 0;

  private onReadyCallback: (() => void) | null = null;

  // ---- join lobby ----
  private joinPanel = byId('join');
  private joinButton = byId<HTMLButtonElement>('join-button');
  private joinSound = byId<HTMLButtonElement>('join-sound');
  private creditsList = byId('credits-list');
  private settingsDrawer = byId('settings');
  private callsignShow = byId('callsign-show');
  private callsignInput = byId<HTMLInputElement>('callsign-input');
  /** Callsign per crew (the server's roster); "car n" until it arrives. */
  private names = new Map<number, string>();

  // ---- stand-by card (first load) and the in-game menu ----
  private standby = byId('standby');
  private standbyFill = byId('standby-fill');
  private standbyText = byId('standby-text');
  private pausePanel = byId('pause');
  private pauseLeave = byId<HTMLButtonElement>('pause-leave');
  private pauseVisible = false;
  private leaveArmed = 0;
  private onResumeCallback: (() => void) | null = null;
  private onLeaveCallback: (() => void) | null = null;
  private onCallsignCallback: ((name: string) => void) | null = null;
  private onRandomCallsignCallback: (() => void) | null = null;
  // The title starts hidden behind the stand-by card; the frame loop reveals it.
  private joinVisible = false;
  private onJoinCallback: (() => void) | null = null;

  // ---- loading (after PLAY, before the match) ----
  private loadingPanel = byId('loading');
  private loadingFill = byId('loading-fill');
  private loadingText = byId('loading-text');
  private loadingKicker = byId('loading-kicker');
  private loadingActive = false;
  private onSoundCallback: (() => void) | null = null;

  private fps = 60;

  constructor() {
    this.bannerButton.addEventListener('click', () => {
      // One vote per visit: disable until the server acknowledges by flipping
      // the phase, which is what actually re-enables on the next results screen.
      this.bannerButton.disabled = true;
      this.onReadyCallback?.();
    });
    // PLAY opens its two choices (vs bots, private room); while a car is held
    // it is REJOIN and goes straight back in.
    const choices = byId('play-choices');
    const bots = byId<HTMLButtonElement>('play-bots');
    bots.addEventListener('click', () => {
      bots.disabled = true;
      this.onJoinCallback?.();
    });
    this.joinButton.addEventListener('click', () => {
      if (!this.joinButton.dataset.rejoin) {
        const open = choices.classList.toggle('hidden') === false;
        this.joinButton.classList.toggle('open', open);
        return;
      }
      this.joinButton.disabled = true;
      this.onJoinCallback?.();
    });
    // Menus: each item with a `data-panel` opens that panel beside the menu,
    // one at a time. SETTINGS is ONE panel shared by the title and the in-game
    // menu — it moves to whichever menu opened it.
    for (const [menuId, panelsId] of [
      ['join', 'join-panels'],
      ['pause', 'pause-panels'],
    ] as const) {
      const menu = byId(menuId);
      const panels = byId(panelsId);
      const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item[data-panel]')];
      for (const item of items) {
        item.addEventListener('click', () => {
          const panel = byId(item.dataset.panel!);
          if (panel.parentElement !== panels) panels.appendChild(panel);
          const open = panel.classList.contains('hidden');
          for (const other of panels.querySelectorAll('.drawer')) other.classList.add('hidden');
          for (const other of items) other.classList.remove('open');
          panel.classList.toggle('hidden', !open);
          item.classList.toggle('open', open);
        });
      }
    }
    byId('callsign-edit').addEventListener('click', () => {
      byId('join-settings').click();
      if (!this.settingsDrawer.classList.contains('hidden')) this.callsignInput.focus();
    });
    this.callsignInput.addEventListener('input', () => this.onCallsignCallback?.(this.callsignInput.value));
    // Typing a callsign must not drive the car or open menus.
    this.callsignInput.addEventListener('keydown', (e) => e.stopPropagation());
    byId('callsign-random').addEventListener('click', () => this.onRandomCallsignCallback?.());
    byId('pause-resume').addEventListener('click', () => this.onResumeCallback?.());
    // Leaving is a forfeit: ask twice.
    this.pauseLeave.addEventListener('click', () => {
      if (performance.now() < this.leaveArmed) {
        this.leaveArmed = 0;
        this.pauseLeave.textContent = 'LEAVE MATCH';
        this.onLeaveCallback?.();
        return;
      }
      this.leaveArmed = performance.now() + 3000;
      this.pauseLeave.textContent = 'CONFIRM — FORFEIT?';
      window.setTimeout(() => {
        if (performance.now() >= this.leaveArmed) this.pauseLeave.textContent = 'LEAVE MATCH';
      }, 3100);
    });
    // A gesture the browser accepts, so the menu can have music before joining.
    this.joinSound.addEventListener('click', () => this.onSoundCallback?.());
  }

  /** Register the sound-toggle handler (menu music). */
  onSound(callback: () => void): void {
    this.onSoundCallback = callback;
  }

  /** Reflect the sound state on the menu button. */
  setSoundOn(on: boolean): void {
    this.joinSound.textContent = on ? 'SOUND ON' : 'SOUND OFF';
    this.joinSound.classList.toggle('on', on);
  }

  // ---- stand-by card --------------------------------------------------------

  /** First-load progress (0..1); `null` cuts to the title with a fade. */
  setStandby(fraction: number | null, text = ''): void {
    if (fraction === null) {
      this.standby.classList.add('gone');
      window.setTimeout(() => this.standby.remove(), 700);
      return;
    }
    this.standbyFill.style.width = `${Math.round(clamp01(fraction) * 100)}%`;
    if (text) this.standbyText.textContent = text;
  }

  // ---- callsign ---------------------------------------------------------------

  setCallsign(name: string): void {
    this.callsignShow.textContent = name || '—';
    if (document.activeElement !== this.callsignInput) this.callsignInput.value = name;
  }

  /** A reason the typed callsign was refused, or '' to clear it. */
  setCallsignError(text: string): void {
    const el = document.getElementById('callsign-error');
    if (el) el.textContent = text;
    this.callsignInput.classList.toggle('bad', text !== '');
  }

  onCallsign(callback: (name: string) => void): void {
    this.onCallsignCallback = callback;
  }

  onRandomCallsign(callback: () => void): void {
    this.onRandomCallsignCallback = callback;
  }

  /** The server's roster: who is driving which car. */
  setNames(names: Map<number, string>): void {
    // Kept by reference: the network layer updates it in place.
    this.names = names;
  }

  private label(crew: number): string {
    return this.names.get(crew) ?? `car ${crew}`;
  }

  /**
   * PLAY becomes REJOIN while a car we left is still being held for us.
   * `seconds` null restores PLAY.
   */
  setRejoin(seconds: number | null): void {
    if (seconds === null) {
      if (this.joinButton.dataset.rejoin) {
        delete this.joinButton.dataset.rejoin;
        this.joinButton.textContent = 'PLAY';
      }
      return;
    }
    this.joinButton.dataset.rejoin = '1';
    this.joinButton.innerHTML = `REJOIN MATCH<small>your car is still out there · ${Math.ceil(seconds)}s</small>`;
  }

  // ---- in-game menu -----------------------------------------------------------

  get paused(): boolean {
    return this.pauseVisible;
  }

  setPauseVisible(visible: boolean): void {
    if (visible === this.pauseVisible) return;
    this.pauseVisible = visible;
    this.pausePanel.classList.toggle('hidden', !visible);
    document.body.classList.toggle('paused', visible);
    if (!visible) {
      for (const d of byId('pause-panels').querySelectorAll('.drawer')) d.classList.add('hidden');
      for (const i of this.pausePanel.querySelectorAll('.menu-item')) i.classList.remove('open');
      this.settingsDrawer.classList.add('hidden');
    }
  }

  onResume(callback: () => void): void {
    this.onResumeCallback = callback;
  }

  onLeave(callback: () => void): void {
    this.onLeaveCallback = callback;
  }

  /** Register the rematch handler. Fired at most once per results screen. */
  onReady(callback: () => void): void {
    this.onReadyCallback = callback;
  }

  /** Register the join-lobby handler. */
  onJoin(callback: () => void): void {
    this.onJoinCallback = callback;
  }

  /**
   * Show or hide the join panel. Joining is explicit: the page loads into a
   * menu, not a match, and the panel comes back if the connection drops.
   */
  setJoinVisible(visible: boolean): void {
    const show = visible && !this.loadingActive;
    // Edge-triggered: re-arming the button every frame would undo the click.
    if (show === this.joinVisible) return;
    this.joinVisible = show;
    this.joinPanel.classList.toggle('hidden', !show);
    // The title card owns the screen: no speedo or weapon read-out behind it.
    document.body.classList.toggle('menu', show);
    if (show) {
      this.joinButton.disabled = false;
      byId<HTMLButtonElement>('play-bots').disabled = false;
    }
  }

  /**
   * The loading screen between PLAY and the match. `fraction` is 0..1; `null`
   * hides it. While it is up the title card stays down, whatever the frame loop
   * says about the connection.
   */
  /**
   * The server is at its player limit: the loading card becomes a waiting card
   * (who is playing, when we try again) with a way back to the title.
   */
  setBusy(
    busy: { online: number; capacity: number; retryIn: number; reason: 'full' | 'rooms' | 'live' } | null,
  ): void {
    this.loadingPanel.classList.toggle('busy', busy !== null);
    this.loadingKicker.textContent = busy ? (busy.reason === 'live' ? 'MATCH UNDER WAY' : 'ARENA FULL') : 'GOING LIVE';
    if (!busy) return;
    if (busy.reason === 'rooms') {
      this.loadingText.textContent =
        `Every arena is mid-match right now. You'll go into the next one that opens ` +
        `(next try in ${Math.max(0, Math.ceil(busy.retryIn))} s), or come back in a few minutes.`;
      return;
    }
    if (busy.reason === 'live') {
      this.loadingText.textContent =
        `That room's match is still running. You'll go in as soon as it ends ` +
        `(checking again in ${Math.max(0, Math.ceil(busy.retryIn))} s).`;
      return;
    }
    this.loadingText.textContent =
      `All ${busy.capacity} seats are taken right now. ` +
      `Hold on here — you'll go in as soon as one frees up (next try in ${Math.max(0, Math.ceil(busy.retryIn))} s), ` +
      `or come back in a few minutes.`;
  }

  /**
   * A new map is loading under a live connection: a card says which, over the
   * half-built scene. Null hides it.
   */
  setMapLoading(name: string | null): void {
    if (name === this.mapLoading) return;
    this.mapLoading = name;
    this.mapCard.classList.toggle('hidden', name === null);
    if (name) this.mapCardName.textContent = name.toUpperCase();
  }
  private mapLoading: string | null = null;
  private mapCard = byId('map-loading');
  private mapCardName = byId('map-loading-name');

  /** Register the handler for leaving the waiting card. */
  onCancelWait(handler: () => void): void {
    byId('loading-cancel').addEventListener('click', handler);
  }

  setLoading(fraction: number | null, text = ''): void {
    this.loadingActive = fraction !== null;
    this.loadingPanel.classList.toggle('hidden', fraction === null);
    if (fraction === null) return;
    this.joinPanel.classList.add('hidden');
    this.joinVisible = false;
    this.loadingFill.style.width = `${Math.round(clamp01(fraction) * 100)}%`;
    if (text) this.loadingText.textContent = text;
  }

  /**
   * Fill the credits drawer: every third-party asset, grouped by section, each
   * linked to its source, and each section ending in the author's attribution
   * with a link to the licence (CC BY requires both).
   */
  setCredits(sections: CreditsSection[]): void {
    const link = (text: string, href: string): HTMLAnchorElement => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = text;
      return a;
    };
    this.creditsList.replaceChildren();
    for (const section of sections) {
      const heading = document.createElement('div');
      heading.className = 'heading';
      heading.textContent = section.heading;
      this.creditsList.appendChild(heading);
      for (const item of section.items) {
        const line = document.createElement('div');
        line.append(link(`“${item.title}”`, item.source));
        this.creditsList.appendChild(line);
      }
      const who = document.createElement('div');
      who.className = 'who';
      who.append(`${section.attribution} · Licensed under `, link(section.license, section.licenseUrl));
      this.creditsList.appendChild(who);
    }
  }

  /**
   * Scoreboard, clock and centre banner.
   *
   * One method rather than several because they are one question — "what is the
   * match doing?" — and splitting it invites a frame where the clock says the
   * match is live and the banner still says lobby.
   */
  setMatch(
    match: MatchSnapshot,
    myTeam: number | null,
    respawnIn: number,
    placement: number | null = null,
    spectatingCrew: number | null = null,
  ): void {
    if (myTeam === null) {
      this.scoreboard.classList.add('hidden');
      this.banner.classList.add('hidden');
      return;
    }

    this.scoreboard.classList.remove('hidden');

    // Two scoreboards, one panel: a duel reads team kills, a solo field reads
    // how many cars are left and how many you have taken.
    if (match.mode === 'solo') {
      this.tag0.textContent = 'ALIVE';
      this.tag1.textContent = 'KILLS';
      this.score0.textContent = String(match.alive);
      this.score1.textContent = String(match.scores[myTeam] ?? 0);
      this.team0.classList.remove('mine');
      this.team1.classList.add('mine');
    } else {
      this.tag0.textContent = 'TEAM A';
      this.tag1.textContent = 'TEAM B';
      this.score0.textContent = String(match.scores[0] ?? 0);
      this.score1.textContent = String(match.scores[1] ?? 0);
      this.team0.classList.toggle('mine', myTeam === 0);
      this.team1.classList.toggle('mine', myTeam === 1);
    }

    // The clock reads regulation time. During the tie-break it announces itself
    // instead, because "0:00" on a live match would be a lie.
    this.clock.classList.toggle('sudden', match.suddenDeath);
    if (match.suddenDeath) this.clock.textContent = 'SUDDEN';
    else if (match.phase === 'live' && match.remainingMs <= 0) this.clock.textContent = '∞';
    else if (match.phase === 'live' || match.phase === 'results') this.clock.textContent = mmss(match.remainingMs);
    else if (match.phase === 'countdown') this.clock.textContent = '0:00';
    else this.clock.textContent = '--:--';

    // ---- banner ----
    if (match.phase === 'lobby') {
      const need = match.mode === 'solo' ? `${match.players} in lobby · waiting for racers` : `${match.players} in lobby · need players on both teams`;
      this.showBanner('WAITING FOR CREWS', need, null);
    } else if (match.phase === 'countdown') {
      const seconds = Math.max(1, Math.ceil(match.remainingMs / 1000));
      this.showBanner(String(seconds), 'GET READY', null);
    } else if (match.phase === 'results') {
      const outcome = match.winner === null ? 'DRAW' : match.winner === myTeam ? 'VICTORY' : 'DEFEAT';
      const tone = match.winner === null ? '' : match.winner === myTeam ? 'win' : 'loss';
      const reason =
        match.reason === 'kill-target'
          ? 'KILL TARGET'
          : match.reason === 'sudden-death'
            ? 'SUDDEN DEATH'
            : match.reason === 'last-standing'
              ? 'LAST CAR STANDING'
              : 'TIME';
      const winnerNote =
        match.winner !== null && match.winner !== myTeam ? ` · winner car ${match.winner}` : '';
      const detail =
        match.mode === 'solo'
          ? `${placement ? `placed #${placement}/${match.roster} · ` : ''}${match.scores[myTeam] ?? 0} kills${winnerNote}`
          : `${match.scores[0]} – ${match.scores[1]}`;
      const ready = `${match.ready}/${match.players} READY`;
      this.showBanner(outcome, `${reason} · ${detail} · ${ready}`, tone);
      this.bannerButton.classList.remove('hidden');
      this.bannerButton.disabled = match.ready >= match.players;
    } else if (respawnIn > 0) {
      this.showBanner('DESTROYED', `respawning in ${Math.ceil(respawnIn)}`, 'loss');
    } else if (placement !== null && spectatingCrew !== null) {
      // Out, but still watching the match decide itself.
      this.showBanner('SPECTATING', `${this.label(spectatingCrew)} · you placed #${placement}`, null);
    } else if (placement !== null) {
      // Solo, dead, and nothing left to watch (or a duel pending respawn).
      this.showBanner('ELIMINATED', `placed #${placement}`, 'loss');
    } else if (match.suddenDeath) {
      this.showBanner('SUDDEN DEATH', 'next kill wins', 'loss');
    } else {
      this.banner.classList.add('hidden');
    }
  }

  /**
   * The closing-zone readout.
   *
   * `outside` is whether OUR car is outside the safe circle — the only moment
   * the warning matters — and drives both the alert text and the red vignette.
   */
  setZone(zone: ZoneState | null, outside: boolean): void {
    this.zonePanel.classList.toggle('hidden', zone === null);
    this.outsideVignette.classList.toggle('on', zone !== null && outside);
    if (!zone) return;

    this.zonePanel.classList.toggle('danger', outside);
    const radius = Math.round(zone.radius);
    const text = outside
      ? `OUTSIDE ZONE — ${Math.round(zone.damagePerSecond)} hull/s`
      : zone.shrinking
        ? `ZONE CLOSING · ${radius} m`
        : zone.nextShrinkMs > 0
          ? `ZONE ${radius} m · SHRINK IN ${mmss(zone.nextShrinkMs)}`
          : `ZONE ${radius} m · FINAL`;
    this.zonePanel.textContent = text;
  }

  /**
   * A damage number at a screen position, where a hit landed. `kill` styles the
   * shot that finished the car. Additive feedback: it says how much, next to the
   * hitmarker that says you connected at all.
   */
  damageNumber(x: number, y: number, amount: number, kill = false): void {
    const el = document.createElement('div');
    el.className = kill ? 'dmg kill' : 'dmg';
    el.textContent = String(Math.round(amount));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.damageLayer.appendChild(el);
    // Bound the layer if a rocket's splash spawns a burst of them at once.
    while (this.damageLayer.childElementCount > 24) this.damageLayer.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), 900);
  }

  /** A one-line hint, shown for `seconds`. Used for first-match onboarding. */
  showTip(text: string, seconds = 6): void {
    this.tip.textContent = text;
    this.tip.classList.add('on');
    this.tipTimer = seconds;
  }

  /**
   * A line in the kill feed. In solo a crew IS a car, so "car n" is a player.
   * A null author is the closing zone, which credits no one.
   */
  addKill(byCrew: number | null, victimCrew: number): void {
    const line = document.createElement('div');
    line.className = 'kill';
    line.textContent =
      byCrew === null
        ? `ZONE eliminated ${this.label(victimCrew)}`
        : `${this.label(byCrew)} eliminated ${this.label(victimCrew)}`;
    this.killfeed.appendChild(line);
    while (this.killfeed.childElementCount > 6) this.killfeed.firstElementChild?.remove();
    window.setTimeout(() => line.remove(), 7000);
  }

  /**
   * The results board: everyone's placing and kills, best first.
   *
   * Sorted by placing, and rows still driving (no placing yet) sort last by
   * kills — so the board reads as a final standing rather than a leaderboard of
   * whoever happened to be winning when you died.
   */
  setBoard(rows: BoardRow[], myTeam: number | null, limit = 10): void {
    if (rows.length === 0) {
      this.board.classList.add('hidden');
      return;
    }

    const sorted = [...rows].sort((a, b) => {
      const pa = a.placement ?? Number.POSITIVE_INFINITY;
      const pb = b.placement ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return b.kills - a.kills;
    });

    this.board.replaceChildren();
    for (const row of sorted.slice(0, limit)) {
      const line = document.createElement('div');
      line.className = row.crew === myTeam ? 'row mine' : 'row';
      const place = document.createElement('span');
      place.textContent = row.placement !== null ? `#${row.placement}` : '—';
      const who = document.createElement('span');
      who.textContent = row.crew === myTeam ? `${this.label(row.crew)} (you)` : this.label(row.crew);
      const kills = document.createElement('span');
      kills.className = 'kills';
      kills.textContent = `${row.kills} kills`;
      line.append(place, who, kills);
      this.board.appendChild(line);
    }
    this.board.classList.remove('hidden');
  }

  /** Red edge as hull runs low. `fraction` is remaining hull, 0..1. */
  setHurt(fraction: number): void {
    const danger = clamp01((0.45 - fraction) / 0.45);
    this.hurt.style.opacity = (danger * 0.85).toFixed(3);
  }

  /**
   * Point at the source of incoming damage. `angle` is radians with 0 straight
   * ahead and positive to the LEFT, matching the game's yaw convention.
   */
  flashDamage(angle: number): void {
    // CSS rotate is clockwise, and a positive angle here is to the left.
    this.hitDir.style.transform = `translate(-50%, -50%) rotate(${(-angle).toFixed(3)}rad)`;
    this.hitDir.classList.add('on');
    this.hitDirTimer = 1.6;
  }

  private showBanner(title: string, sub: string, tone: 'win' | 'loss' | '' | null): void {
    this.banner.classList.remove('hidden');
    this.bannerTitle.textContent = title;
    this.bannerTitle.className = `title${tone ? ` ${tone}` : ''}`;
    this.bannerSub.textContent = sub;
    if (tone === null) this.bannerButton.classList.add('hidden');
  }

  update(state: VehicleState, dt: number): void {
    if (dt > 0) this.fps += ((1 / dt) - this.fps) * 0.08;

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) this.hitmarker.classList.remove('on');
    }
    if (this.hitDirTimer > 0) {
      this.hitDirTimer -= dt;
      if (this.hitDirTimer <= 0) this.hitDir.classList.remove('on');
    }
    if (this.hitFlashLevel > 0) {
      this.hitFlashLevel = Math.max(0, this.hitFlashLevel - dt * 3.2);
      this.hitFlash.style.opacity = this.hitFlashLevel.toFixed(3);
    }
    if (this.killConfirmTimer > 0) {
      this.killConfirmTimer -= dt;
      if (this.killConfirmTimer <= 0) this.killConfirm.classList.remove('on');
    }
    if (this.tipTimer > 0) {
      this.tipTimer -= dt;
      if (this.tipTimer <= 0) this.tip.classList.remove('on');
    }

    const speed = Math.hypot(state.vel.x, state.vel.z);
    const kmh = Math.round(speed * 3.6);

    this.speedValue.textContent = String(kmh);

    // Threshold kept low so the readout actually acknowledges a slide rather
    // than staying silent until the car is already sideways.
    let mode = 'GROUND';
    if (!state.onGround) mode = 'AIRBORNE';
    else if (Math.abs(state.slipSpeed) > 3) mode = 'DRIFT';
    this.tState.textContent = mode;

    this.tFps.textContent = String(Math.round(this.fps));

    const pct = (state.boost / VEHICLE.boost.max) * 100;
    this.boostFill.style.width = `${pct}%`;
    this.boostPct.textContent = `${Math.round(pct)}%`;
  }

  setPromptVisible(visible: boolean): void {
    this.prompt.classList.toggle('hidden', !visible);
    this.controls.classList.toggle('hidden', !visible);
  }

  /** Connection lifecycle text, driven by the network layer. */
  setStatus(text: string): void {
    this.tStatus.textContent = text;
    this.tStatus.className = text === 'in game' ? 'ok' : 'bad';
  }

  /**
   * Network readout.
   *
   * Ping and latency look redundant but are not: ping is the round trip, while
   * latency is the one-way trip that our input and the server's state each pay.
   * The composite — one-way plus the deliberate interpolation delay — is the
   * number that actually describes the game, because it is how old the world
   * being rendered is.
   */
  /**
   * Flash the hitmarker. Confirmation comes from the SERVER's shot event, not
   * from our own prediction — the feedback has to mean "you actually hit", not
   * "your client thinks you did".
   */
  flashHitmarker(): void {
    this.hitmarker.classList.add('on');
    this.hitmarkerTimer = 0.14;
  }

  /**
   * Show or hide the crosshair.
   *
   * The driver is unarmed, and their camera looks at the car — so a crosshair
   * would sit on their own roof and mean nothing. It is an aiming aid, and only
   * gunners aim.
   */
  setCrosshairVisible(visible: boolean): void {
    this.crosshair.style.display = visible ? '' : 'none';
  }

  /**
   * The car-mounted weapons' read-out: one row per trigger. Replaces the held
   * weapon line when the seat's weapons are bolted on (each fires on its own
   * button and reloads on its own clock). `null` restores the single-weapon view.
   */
  setMountedWeapons(
    weapons: Array<{ name: string; rounds: number; magazine: number; reload: number; reloadTotal: number }> | null,
  ): void {
    this.cWeapon2Row.classList.toggle('hidden', !weapons || weapons.length < 2);
    this.cKey.style.display = weapons ? '' : 'none';
    if (!weapons) return;
    const [primary, secondary] = weapons;
    if (primary) {
      this.cWeapon.textContent = primary.name.toUpperCase();
      this.cAmmo.textContent = primary.reload > 0 ? `RELOAD ${primary.reload.toFixed(1)}s` : `${primary.rounds} / ${primary.magazine}`;
      const fill = primary.reload > 0 ? 1 - primary.reload / primary.reloadTotal : primary.rounds / primary.magazine;
      this.cAmmoFill.style.width = `${Math.round(clamp01(fill) * 100)}%`;
    }
    if (secondary) {
      this.cWeapon2.textContent = secondary.name.toUpperCase();
      const ready = secondary.reload <= 0 && secondary.rounds > 0;
      this.cAmmo2.textContent = ready ? 'READY' : `RELOAD ${secondary.reload.toFixed(1)}s`;
      this.cWeapon2Row.classList.toggle('ready', ready);
      const fill = ready ? 1 : 1 - secondary.reload / secondary.reloadTotal;
      this.cAmmo2Fill.style.width = `${Math.round(clamp01(fill) * 100)}%`;
    }
  }

  /**
   * Place each weapon's reticle at the screen point it will actually hit.
   * `outside` = the target is past what that gun can turn to; `reloading` dims.
   */
  setReticles(
    reticles: Array<{ x: number; y: number; visible: boolean; outside: boolean; reloading: boolean }>,
  ): void {
    this.reticles.forEach((el, i) => {
      const r = reticles[i];
      el.classList.toggle('hidden', !r || !r.visible);
      if (!r || !r.visible) return;
      el.style.left = `${r.x.toFixed(1)}px`;
      el.style.top = `${r.y.toFixed(1)}px`;
      el.classList.toggle('outside', r.outside);
      el.classList.toggle('reloading', r.reloading);
    });
  }

  /**
   * We took damage: a red flash in from the screen edges, stronger for a bigger
   * hit, plus a flash on the hull bar. `fraction` is the hull lost, 0..1.
   */
  flashHit(fraction: number): void {
    this.hitFlashLevel = Math.min(1, Math.max(this.hitFlashLevel, 0.45 + fraction * 6));
    this.hullBar.parentElement?.classList.remove('flash');
    void this.hullBar.offsetWidth; // restart the animation
    this.hullBar.parentElement?.classList.add('flash');
  }

  /** A kill we scored: a brief banner in the middle of the screen. */
  confirmKill(text: string): void {
    this.killConfirm.textContent = text;
    this.killConfirm.classList.add('on');
    this.killConfirmTimer = 1.4;
  }

  /** Weapon, ammo, health and hull. The M5 read-out. */
  setCombat(self: {
    hp: number;
    hull: number;
    weapon: string;
    rounds: number;
    magazine: number;
    reload: number;
    alive: boolean;
    /** The driver carries nothing, so their weapon read-out would be a lie. */
    armed: boolean;
    /** Component health, for the pip read-outs (DESIGN.md §4.2). */
    components: Components;
    /** True while the server is healing us at a crate. */
    repairing: boolean;
    /** Crew health only means something when you can die apart from the car. */
    showHealth: boolean;
  }): void {
    const reloading = self.reload > 0;
    const showAmmo = self.armed && self.alive;
    this.cWeapon.textContent = !self.armed
      ? 'UNARMED'
      : self.alive
        ? self.weapon.toUpperCase()
        : 'DOWN';
    this.cAmmo.textContent = !self.armed
      ? '—'
      : reloading
        ? `RELOAD ${self.reload.toFixed(1)}s`
        : `${self.rounds} / ${self.magazine}`;
    const fraction = self.magazine > 0 ? self.rounds / self.magazine : 0;
    this.cAmmoFill.style.width = `${showAmmo ? (reloading ? 100 : fraction * 100) : 0}%`;
    this.cHealth.textContent = String(Math.round(self.alive ? self.hp : 0));
    this.cHull.textContent = String(Math.round(self.hull));
    this.cHullFill.style.width = `${Math.round(clamp01(self.hull / COMBAT.maxHull) * 100)}%`;
    this.cHealthRow.classList.toggle('hidden', !self.showHealth);

    setPip(this.cEngine, integrity(self.components.engine));
    setPip(this.cTyres, wheelIntegrity(self.components));

    this.cRepairing.classList.toggle('on', self.repairing);
  }

  setNet(ping: number, jitter: number, players: number, connected: boolean): void {
    const live = connected && ping > 0;
    const oneWay = live ? ping / 2 : 0;

    this.tPlayers.textContent = String(players);
    this.tPing.textContent = live ? `${Math.round(ping)} ms` : '–';
    this.tJitter.textContent = live ? `±${Math.round(jitter)} ms` : '–';
    this.tLatency.textContent = live ? `${Math.round(oneWay)} ms` : '–';
    this.tWorld.textContent = live ? `${Math.round(NET.interpDelayMs + oneWay)} ms` : '–';

    // Colour ping by whether it would actually be a problem.
    this.tPing.className = !connected ? 'bad' : ping < 60 ? 'ok' : ping < 150 ? '' : 'bad';
    this.tJitter.className = !connected ? 'bad' : jitter < 20 ? 'ok' : jitter < 60 ? '' : 'bad';
  }
}
