/**
 * The garage (M12): choose paint, wheels and a roof kit from what you have
 * unlocked. Cosmetic-only by construction — nothing here can change how the car
 * drives, so there is no power to sell and nothing to balance.
 *
 * The panel is plain DOM inside the join menu, rebuilt whenever the profile or
 * the selection changes. Locked entries are still shown, disabled, with the
 * requirement on the label: seeing the thing you are working toward is the point
 * of an unlock.
 */

import {
  LIVERIES,
  WHEELS,
  shopCatalog,
  type CosmeticKind,
  type CosmeticLook,
  type Profile,
  type ShopEntry,
} from '../shared/cosmetics';

export type { CosmeticLook };

const KIND_LABELS: Record<CosmeticKind, string> = {
  livery: 'PAINT',
  wheels: 'WHEELS',
  roof: 'ROOF',
};

function swatchColour(entry: ShopEntry): string | null {
  if (entry.kind === 'livery') return `#${LIVERIES[entry.index].body.toString(16).padStart(6, '0')}`;
  if (entry.kind === 'wheels') return `#${WHEELS[entry.index].hub.toString(16).padStart(6, '0')}`;
  return null;
}

export class Garage {
  private readonly root: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly rows = new Map<CosmeticKind, HTMLElement>();
  private profile: Profile;
  private onLookCallback: ((look: CosmeticLook) => void) | null = null;

  constructor(root: HTMLElement, profile: Profile) {
    this.root = root;
    this.profile = profile;
    this.stats = root.querySelector('#cos-stats') as HTMLElement;

    // Paint only (see main.ts `paintOnly`): wheel styles and roof kits do
    // nothing on the realistic cars, so they are not offered.
    for (const kind of ['livery'] as CosmeticKind[]) {
      const row = root.querySelector(`#cos-${kind}`) as HTMLElement;
      if (row) this.rows.set(kind, row);
    }
    this.root.addEventListener('click', (event) => this.onClick(event));
  }

  onLook(callback: (look: CosmeticLook) => void): void {
    this.onLookCallback = callback;
  }

  render(profile: Profile): void {
    this.profile = profile;
    this.stats.textContent = `${profile.matches} matches · ${profile.kills} kills · ${profile.wins} wins`;

    for (const entry of shopCatalog(profile)) {
      const row = this.rows.get(entry.kind);
      if (!row) continue;
      const button = row.querySelector(`[data-index="${entry.index}"]`) as HTMLButtonElement | null;
      if (!button) continue;
      const selected = this.profile.look[entry.kind] === entry.index;
      button.classList.toggle('locked', !entry.unlocked);
      button.classList.toggle('selected', selected);
      button.disabled = !entry.unlocked;
      const progress = entry.progress
        ? ` (${Math.min(entry.progress.at, entry.progress.of)}/${entry.progress.of})`
        : '';
      button.title = entry.unlocked ? entry.name : `${entry.name} — ${entry.requirement}${progress}`;
      // A locked paint says what unlocks it ON the chip, not only in a tooltip:
      // greyed out with no reason reads as broken.
      const need = button.querySelector('.cos-need') as HTMLElement | null;
      if (need) need.textContent = entry.unlocked ? '' : `${entry.requirement}${progress}`;
    }
  }

  /** Build the buttons once; `render` only restyles them. */
  build(): void {
    for (const entry of shopCatalog(this.profile)) {
      const row = this.rows.get(entry.kind);
      if (!row) continue;
      const button = document.createElement('button');
      button.className = 'cos-option';
      button.dataset.kind = entry.kind;
      button.dataset.index = String(entry.index);
      button.setAttribute('aria-label', `${KIND_LABELS[entry.kind]}: ${entry.name}`);

      const swatch = swatchColour(entry);
      if (swatch) {
        const chip = document.createElement('i');
        chip.className = 'cos-swatch';
        chip.style.background = swatch;
        button.appendChild(chip);
      }
      const name = document.createElement('span');
      name.textContent = entry.name;
      button.appendChild(name);
      const need = document.createElement('small');
      need.className = 'cos-need';
      button.appendChild(need);
      row.appendChild(button);
    }
    this.render(this.profile);
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest('button.cos-option') as HTMLButtonElement | null;
    if (!target || target.disabled) return;
    const kind = target.dataset.kind as CosmeticKind | undefined;
    const index = Number(target.dataset.index);
    if (!kind || !Number.isFinite(index)) return;
    const look: CosmeticLook = { ...this.profile.look, [kind]: index };
    this.onLookCallback?.(look);
  }
}
