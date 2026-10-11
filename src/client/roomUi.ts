/**
 * Private rooms on the page: the PRIVATE ROOM drawer on the title (create a
 * room, or join one with a code or an invite link) and the room's lobby
 * (code, invite link, players, the host's map choice, START).
 */

import { MAPS } from '../shared/arena';
import { MAP_IDS, type MapId } from '../shared/mapIds';
import { FORMAT_IDS, FORMATS, type FormatId } from '../shared/formats';
import type { SeatId } from '../shared/crews';
import type { RoomState } from './net';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

/** Why a room could not be joined, in words. */
const REFUSALS: Record<string, string> = {
  'no such room': 'No room with that code — check it with whoever sent it.',
  'room full': 'That room is full (12 players).',
  'no rooms free': 'Every room on the server is in use — try again in a few minutes.',
};

export class RoomUi {
  private codeInput = byId<HTMLInputElement>('room-code');
  private error = byId('room-error');
  private lobby = byId('room-lobby');
  private codeShow = byId('room-code-show');
  private copyButton = byId<HTMLButtonElement>('room-copy');
  private count = byId('room-count');
  private players = byId('room-players');
  private maps = byId('room-maps');
  private startButton = byId<HTMLButtonElement>('room-start');
  private wait = byId('room-wait');
  private mapButtons = new Map<MapId, HTMLButtonElement>();
  private formatButtons = new Map<FormatId, HTMLButtonElement>();
  private formats = byId('room-formats');
  private cars = byId('room-cars');
  private onPickFormat: ((format: FormatId) => void) | null = null;
  private onSit: ((crew: number, seat: SeatId) => void) | null = null;
  private shownKey = '';
  private visible = false;

  private onJoinRoom: ((room: string) => void) | null = null;
  private onPickMap: ((map: MapId) => void) | null = null;
  private onStart: (() => void) | null = null;
  private onLeave: (() => void) | null = null;

  constructor() {
    byId('room-create').addEventListener('click', () => this.onJoinRoom?.('new'));
    const join = (): void => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(code)) {
        this.setError('A room code is five letters.');
        return;
      }
      this.onJoinRoom?.(code);
    };
    byId('room-join').addEventListener('click', join);
    // Typing a code must not drive the car or open menus.
    this.codeInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') join();
    });
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
      this.setError('');
    });
    this.copyButton.addEventListener('click', () => void this.copyInvite());
    this.startButton.addEventListener('click', () => this.onStart?.());
    byId('room-leave').addEventListener('click', () => this.onLeave?.());

    for (const id of FORMAT_IDS) {
      const button = document.createElement('button');
      button.className = 'map-option format-option';
      const name = document.createElement('b');
      name.textContent = FORMATS[id].name.toUpperCase();
      const blurb = document.createElement('span');
      blurb.textContent = FORMATS[id].blurb;
      button.append(name, blurb);
      button.addEventListener('click', () => this.onPickFormat?.(id));
      this.formats.appendChild(button);
      this.formatButtons.set(id, button);
    }
    // Seat picker: one click sits you there (team formats).
    this.cars.addEventListener('click', (e) => {
      const seat = (e.target as HTMLElement).closest<HTMLButtonElement>('.seat-option');
      if (!seat || seat.disabled) return;
      this.onSit?.(Number(seat.dataset.crew), seat.dataset.seat as SeatId);
    });

    for (const id of MAP_IDS) {
      const button = document.createElement('button');
      button.className = 'map-option';
      const name = document.createElement('b');
      name.textContent = MAPS[id].name.toUpperCase();
      const blurb = document.createElement('span');
      blurb.textContent = MAPS[id].blurb;
      button.append(name, blurb);
      button.addEventListener('click', () => this.onPickMap?.(id));
      this.maps.appendChild(button);
      this.mapButtons.set(id, button);
    }
  }

  /** An invite link (`?room=CODE`) opens the drawer with the code filled in. */
  prefill(code: string): void {
    this.codeInput.value = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    this.showChoices();
    const item = byId('join-private');
    if (!item.classList.contains('open')) item.click();
  }

  /** Unfold PLAY's choices (the private room lives there). */
  private showChoices(): void {
    byId('play-choices').classList.remove('hidden');
    byId('join-button').classList.add('open');
  }

  handlers(h: {
    join: (room: string) => void;
    pickMap: (map: MapId) => void;
    pickFormat: (format: FormatId) => void;
    sit: (crew: number, seat: SeatId) => void;
    start: () => void;
    leave: () => void;
  }): void {
    this.onPickFormat = h.pickFormat;
    this.onSit = h.sit;
    this.onJoinRoom = h.join;
    this.onPickMap = h.pickMap;
    this.onStart = h.start;
    this.onLeave = h.leave;
  }

  setError(text: string): void {
    this.error.textContent = text;
  }

  /** A refusal from the server, in words. */
  showRefusal(reason: string): void {
    this.setError(REFUSALS[reason] ?? `Could not join (${reason}).`);
    this.showChoices();
    const item = byId('join-private');
    if (!item.classList.contains('open')) item.click();
  }

  get lobbyVisible(): boolean {
    return this.visible;
  }

  /** The room's lobby, or null to hide it. Cheap to call every frame. */
  setLobby(room: RoomState | null, myName: string): void {
    const show = room !== null;
    if (show !== this.visible) {
      this.visible = show;
      this.lobby.classList.toggle('hidden', !show);
      this.copyButton.textContent = 'COPY INVITE LINK';
    }
    if (!room) return;
    const key = JSON.stringify(room);
    if (key === this.shownKey) return;
    this.shownKey = key;

    this.codeShow.textContent = room.code;
    this.count.textContent = `PLAYERS ${room.players.length}/${room.max}`;
    this.players.replaceChildren(
      ...room.players.map((name) => {
        const li = document.createElement('li');
        li.textContent = name;
        if (name === room.hostName) li.classList.add('host');
        if (name === myName) li.classList.add('me');
        return li;
      }),
    );
    for (const [id, button] of this.mapButtons) {
      button.classList.toggle('selected', id === room.map);
      button.disabled = !room.host;
    }
    for (const [id, button] of this.formatButtons) {
      button.classList.toggle('selected', id === room.format);
      button.disabled = !room.host;
    }
    // The cars and their seats (duos, squads): tap a free seat to sit in it.
    this.cars.classList.toggle('hidden', room.cars.length === 0);
    this.cars.replaceChildren(
      ...room.cars.map((car) => {
        const row = document.createElement('div');
        row.className = 'car-row';
        const label = document.createElement('span');
        label.className = 'cos-label';
        label.textContent = `${room.format === 'squads' ? 'TRUCK' : 'CAR'} ${car.crew + 1}`;
        row.appendChild(label);
        for (const seat of car.seats) {
          const b = document.createElement('button');
          b.className = 'chip seat-option';
          if (seat.me) b.classList.add('on');
          b.dataset.crew = String(car.crew);
          b.dataset.seat = seat.seat;
          b.disabled = seat.name !== null;
          const role = seat.seat === 'seat.driver' ? 'DRIVER' : 'GUNNER';
          b.textContent = seat.name ? `${role} · ${seat.name}` : `${role} · free`;
          row.appendChild(b);
        }
        return row;
      }),
    );
    const short = room.min - room.players.length;
    const occupiedCars = room.cars.filter((c) => c.seats.some((s) => s.name)).length;
    const needCars = room.cars.length > 0 && occupiedCars < 2;
    this.startButton.classList.toggle('hidden', !room.host);
    this.startButton.disabled = short > 0 || needCars;
    this.startButton.textContent = short > 0 ? `NEED ${short} MORE` : needCars ? 'NEED 2 CARS' : 'START MATCH';
    this.wait.textContent = room.host
      ? short > 0
        ? 'Waiting for friends to join. Share the code or the link.'
        : needCars
          ? 'Team match: at least two cars need someone in them.'
          : 'Pick a map and start whenever you are ready.'
      : `Waiting for ${room.hostName || 'the host'} to start the match.`;
  }

  private async copyInvite(): Promise<void> {
    const code = this.codeShow.textContent ?? '';
    const link = `${location.origin}/?room=${code}`;
    try {
      // Phones: the share sheet; elsewhere, the clipboard.
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'YOVNOK', text: `Join my YOVNOK room: ${code}`, url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      this.copyButton.textContent = 'LINK COPIED';
    } catch {
      this.copyButton.textContent = link;
    }
  }
}
