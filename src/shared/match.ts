/**
 * Match flow: the rules of a duel (DESIGN.md §2.1, §12.1).
 *
 * Pure and deterministic — every function takes the current server clock as an
 * argument rather than reading it — for the same reason the simulation is: the
 * server is the only thing that should decide when a match starts, ends, or
 * awards a point, and putting those rules in a function with no sockets or
 * timers attached is what makes them testable on their own.
 *
 * The lifecycle:
 *
 *   lobby ──(both teams present)──► countdown ──► live ──► results ──► lobby
 *
 * `live` ends three ways:
 *   - a team reaches the kill target (an early win / mercy condition),
 *   - regulation expires with a leader (the usual ending),
 *   - regulation expires TIED, which opens sudden death: the next kill wins,
 *     and if nobody scores within its cap the match is a draw.
 *
 * A team IS a crew: one vehicle per team, two teams per match (§2). Scores are
 * indexed by crew id, which is what the rest of the room already speaks.
 */

import { MATCH } from './config';

export type MatchPhase = 'lobby' | 'countdown' | 'live' | 'results';

/**
 * How a match is won. `duel` is respawn team deathmatch between two crews;
 * `solo` is one-man teams, one vehicle life each, last car standing
 * (DESIGN.md §2.1, §2.3). The rules differ only in what ends a match and whether
 * a destroyed crew comes back — the phase machine is the same.
 */
export type MatchMode = 'duel' | 'solo';

/** Why a match ended, for the results screen. `null` while it has not. */
export type MatchEndReason =
  | 'kill-target'
  | 'time'
  | 'sudden-death'
  | 'last-standing'
  | null;

export type MatchState = {
  mode: MatchMode;
  phase: MatchPhase;
  /**
   * Server clock (ms) at which the current phase ends. `0` when a phase is
   * open-ended — the lobby waits forever, and a forced-live room never expires.
   */
  endsAt: number;
  /** Kills per team, indexed by crew/team id. */
  scores: number[];
  /** Winning team once `results`, `null` for a draw or before the end. */
  winner: number | null;
  reason: MatchEndReason;
  /** True once a tied regulation has opened the one-kill-wins tie-break. */
  suddenDeath: boolean;
};

/**
 * The tunable subset of the rules, resolved for one match. Kept separate from
 * config so tests can run a match with a 1-second clock instead of waiting.
 */
export type MatchRules = {
  mode: MatchMode;
  killTarget: number;
  timeLimitSeconds: number;
  countdownSeconds: number;
  resultsSeconds: number;
  suddenDeathSeconds: number;
  /** Seconds a destroyed crew waits before respawning. Duel only. */
  vehicleRespawnSeconds: number;
  /** Players required on EACH team to start. Duel only. */
  minPlayersPerTeam: number;
  /** Players required in TOTAL to start. Solo only. */
  minPlayers: number;
};

/**
 * Resolve the rules for a crew size and mode.
 *
 * The two modes share every clock and differ in what ends a match: a duel
 * scores kills against a target and respawns the dead, while solo is
 * last-car-standing with one life, so its kill target is unreachable by design
 * and the elimination check is what finishes it.
 */
export function matchRules(
  playersPerTeam: number,
  overrides: Partial<MatchRules> = {},
  mode: MatchMode = playersPerTeam <= 1 ? 'solo' : 'duel',
): MatchRules {
  return {
    mode,
    killTarget:
      mode === 'solo'
        ? Number.POSITIVE_INFINITY
        : playersPerTeam <= 2
          ? MATCH.killTargetCoupe
          : MATCH.killTargetSuv,
    // Solo runs until one car remains; a duel runs against the clock. 0 = none.
    timeLimitSeconds: mode === 'solo' ? MATCH.soloTimeLimitSeconds : MATCH.timeLimitSeconds,
    countdownSeconds: MATCH.countdownSeconds,
    resultsSeconds: MATCH.resultsSeconds,
    suddenDeathSeconds: MATCH.suddenDeathSeconds,
    vehicleRespawnSeconds: MATCH.vehicleRespawnSeconds,
    minPlayersPerTeam: MATCH.minPlayersPerTeam,
    minPlayers: MATCH.soloMinPlayers,
    ...overrides,
  };
}

export function createMatchState(teamCount: number, mode: MatchMode = 'duel'): MatchState {
  return {
    mode,
    phase: 'lobby',
    endsAt: 0,
    scores: Array.from({ length: teamCount }, () => 0),
    winner: null,
    reason: null,
    suddenDeath: false,
  };
}

/** Whether the field has the humans it needs for a match to begin. */
export function enoughPlayers(counts: readonly number[], rules: MatchRules): boolean {
  // Solo is a field of one-man teams, most of them empty: requiring every team
  // to be manned would mean waiting for all eight. A total is the right measure.
  if (rules.mode === 'solo') {
    const total = counts.reduce((sum, count) => sum + count, 0);
    return total >= rules.minPlayers;
  }
  return counts.length > 0 && counts.every((count) => count >= rules.minPlayersPerTeam);
}

/** Indices of the highest-scoring team(s). More than one means a tie. */
export function leadingTeams(scores: readonly number[]): number[] {
  let best = -Infinity;
  for (const score of scores) if (score > best) best = score;
  const leaders: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] === best) leaders.push(i);
  return leaders;
}

/** Clear the board and open the countdown. Used at the start and on rematch. */
export function beginCountdown(state: MatchState, now: number, rules: MatchRules): void {
  state.phase = 'countdown';
  state.endsAt = now + rules.countdownSeconds * 1000;
  state.winner = null;
  state.reason = null;
  state.suddenDeath = false;
  for (let i = 0; i < state.scores.length; i++) state.scores[i] = 0;
}

export function finishMatch(
  state: MatchState,
  winner: number | null,
  reason: MatchEndReason,
  now: number,
  rules: MatchRules,
): void {
  state.phase = 'results';
  state.endsAt = now + rules.resultsSeconds * 1000;
  state.winner = winner;
  state.reason = reason;
  state.suddenDeath = false;
}

/**
 * Award a kill to `team`.
 *
 * Returns true if this kill ENDED the match, so the caller can clear pending
 * combat. A kill only scores while `live`: shots fired in the lobby or during
 * the results screen must not move the board.
 */
export function registerKill(
  state: MatchState,
  team: number,
  now: number,
  rules: MatchRules,
): boolean {
  if (state.phase !== 'live') return false;
  if (team < 0 || team >= state.scores.length) return false;
  state.scores[team]++;

  if (state.suddenDeath) {
    finishMatch(state, team, 'sudden-death', now, rules);
    return true;
  }
  if (state.scores[team] >= rules.killTarget) {
    finishMatch(state, team, 'kill-target', now, rules);
    return true;
  }
  return false;
}

/**
 * A car has been eliminated.
 *
 * Only meaningful in a last-standing match. `aliveAfter` counts the cars still
 * driving once this one is out; one remaining wins, none is a draw. Returns true
 * if this ended the match.
 */
export function registerElimination(
  state: MatchState,
  aliveAfter: number,
  aliveTeam: number | null,
  now: number,
  rules: MatchRules,
): boolean {
  if (state.phase !== 'live' || rules.mode !== 'solo') return false;
  if (aliveAfter <= 0) {
    finishMatch(state, null, 'last-standing', now, rules);
    return true;
  }
  if (aliveAfter === 1) {
    finishMatch(state, aliveTeam, 'last-standing', now, rules);
    return true;
  }
  return false;
}

/**
 * Advance the clock-driven transitions.
 *
 * `counts` is how many players are on each team right now, so a team emptying
 * out mid-countdown drops the match back to the lobby rather than starting a
 * one-sided game (DESIGN.md §12.3 keeps the seat empty; it does not invent a
 * player to fill it).
 *
 * `forceLive` is a test affordance: it pins the phase to `live` with no clock,
 * so netcode and combat harnesses are not made to wait out a lobby.
 */
export function tickMatch(
  state: MatchState,
  now: number,
  rules: MatchRules,
  counts: readonly number[],
  forceLive = false,
): void {
  if (forceLive) {
    state.phase = 'live';
    state.endsAt = 0;
    return;
  }

  switch (state.phase) {
    case 'lobby':
      if (enoughPlayers(counts, rules)) beginCountdown(state, now, rules);
      break;

    case 'countdown':
      // Someone left before the whistle: go back to waiting rather than start.
      if (!enoughPlayers(counts, rules)) {
        state.phase = 'lobby';
        state.endsAt = 0;
        break;
      }
      if (now >= state.endsAt) {
        state.phase = 'live';
        // `endsAt` of 0 means no clock: the match ends by elimination only.
        state.endsAt = rules.timeLimitSeconds > 0 ? now + rules.timeLimitSeconds * 1000 : 0;
      }
      break;

    case 'live':
      if (state.endsAt > 0 && now >= state.endsAt) {
        if (state.suddenDeath) {
          // Still tied after the tie-break: a draw.
          finishMatch(state, null, 'time', now, rules);
        } else {
          const leaders = leadingTeams(state.scores);
          if (leaders.length === 1) finishMatch(state, leaders[0], 'time', now, rules);
          else {
            state.suddenDeath = true;
            state.endsAt = now + rules.suddenDeathSeconds * 1000;
          }
        }
      }
      break;

    case 'results':
      // The room decides when to leave results: an all-ready rematch vote or
      // the results timer. Kept out of here so the vote can be tested apart.
      break;
  }
}

/** Wire shape of the match, sent with every snapshot. */
export type MatchSnapshot = {
  mode: MatchMode;
  phase: MatchPhase;
  /** Milliseconds left in the current phase; `0` when open-ended. */
  remainingMs: number;
  scores: number[];
  winner: number | null;
  reason: MatchEndReason;
  suddenDeath: boolean;
  /** Cars still driving. Solo's scoreboard; unused by a duel (always 2). */
  alive: number;
  /** Players who have voted for a rematch, and how many are connected. */
  ready: number;
  /** Humans in the match — the rematch quorum. */
  players: number;
  /**
   * Everyone on the field, humans and bots. Sent as its own number because
   * interest management stops the snapshot's member list being a reliable count
   * of the match: a client only sees what is near it.
   */
  roster: number;
};

export function matchSnapshotOf(
  state: MatchState,
  now: number,
  ready: number,
  players: number,
  alive: number,
  roster = players,
): MatchSnapshot {
  return {
    mode: state.mode,
    phase: state.phase,
    remainingMs: state.phase === 'lobby' ? 0 : Math.max(0, state.endsAt - now),
    scores: [...state.scores],
    winner: state.winner,
    reason: state.reason,
    suddenDeath: state.suddenDeath,
    alive,
    ready,
    players,
    roster,
  };
}
