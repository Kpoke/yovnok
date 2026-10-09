/**
 * The monthly bandwidth guard: the hard edge of the hosting budget.
 *
 * The server's plan includes a fixed amount of outbound transfer a month; past
 * it the host bills per GB, with no spending cap. This counts what actually
 * left the machine — the kernel's transmit counter, which is what the host
 * meters — accumulates it for the calendar month (surviving restarts, which
 * reset the counter), and reports where we stand against BANDWIDTH_BUDGET_GB:
 *
 *   under 85%   normal
 *   85–100%     normal, with a warning in the log (and on /healthz)
 *   at 100%     OVER: no new players are admitted and new visitors get a short
 *               "over capacity this month" page instead of a 40 MB download.
 *               Matches already running finish normally. It resets on the 1st.
 *
 * Off when BANDWIDTH_BUDGET_GB is unset (development).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_GB = Number(process.env.BANDWIDTH_BUDGET_GB ?? 0);
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'bandwidth.json');
const SAMPLE_MS = 60_000;

type Ledger = { month: string; bytes: number; lastCounter: number };

const monthOf = (d = new Date()): string => d.toISOString().slice(0, 7);

/** Bytes transmitted by every non-loopback interface, from /proc/net/dev. */
function txCounter(): number | null {
  try {
    const lines = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let total = 0;
    for (const line of lines) {
      const [name, rest] = line.split(':');
      if (!rest || name.trim() === 'lo') continue;
      const fields = rest.trim().split(/\s+/);
      total += Number(fields[8] ?? 0); // transmit bytes
    }
    return total;
  } catch {
    return null; // not Linux: no guard
  }
}

class BandwidthGuard {
  private ledger: Ledger = { month: monthOf(), bytes: 0, lastCounter: 0 };
  private warned = false;

  constructor() {
    if (BUDGET_GB <= 0) return;
    try {
      this.ledger = JSON.parse(readFileSync(FILE, 'utf8')) as Ledger;
      // A restart (a new container) resets the kernel counter, so the first
      // sample counts from 0. If it did not reset, this over-counts — which
      // errs on the safe side of the budget.
      this.ledger.lastCounter = 0;
    } catch {
      // First run ever: count from NOW, not everything since the machine booted.
      this.ledger = { month: monthOf(), bytes: 0, lastCounter: txCounter() ?? 0 };
    }
    this.sample();
    setInterval(() => this.sample(), SAMPLE_MS).unref();
    console.log(`[bandwidth] budget ${BUDGET_GB} GB/month · used ${this.usedGb.toFixed(2)} GB in ${this.ledger.month}`);
  }

  get enabled(): boolean {
    return BUDGET_GB > 0;
  }

  get usedGb(): number {
    return this.ledger.bytes / 1024 ** 3;
  }

  /** Fraction of the month's budget used (0 when disabled). */
  get fraction(): number {
    return this.enabled ? this.usedGb / BUDGET_GB : 0;
  }

  /** At or past the budget: admit no one new until the month turns. */
  get over(): boolean {
    return this.enabled && this.fraction >= 1;
  }

  status(): { usedGb: number; budgetGb: number; over: boolean } | null {
    if (!this.enabled) return null;
    return { usedGb: Math.round(this.usedGb * 100) / 100, budgetGb: BUDGET_GB, over: this.over };
  }

  private sample(): void {
    const counter = txCounter();
    if (counter === null) return;
    const month = monthOf();
    if (month !== this.ledger.month) {
      this.ledger = { month, bytes: 0, lastCounter: counter };
      this.warned = false;
    }
    // The counter only resets (to 0) on a restart; then count all of it.
    const delta = counter >= this.ledger.lastCounter ? counter - this.ledger.lastCounter : counter;
    this.ledger.bytes += delta;
    this.ledger.lastCounter = counter;
    if (this.fraction >= 0.85 && !this.warned) {
      this.warned = true;
      console.warn(`[bandwidth] WARNING: ${this.usedGb.toFixed(1)} of ${BUDGET_GB} GB used this month`);
    }
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify(this.ledger));
    } catch {
      // A read-only disk loses the history, not the guard.
    }
  }
}

export const bandwidth = new BandwidthGuard();
