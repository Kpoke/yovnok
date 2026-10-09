/**
 * Frame-time diagnostics, for the F3 debug overlay.
 *
 * An FPS counter says THAT frames are slow, not WHY. On a 120 Hz display any
 * frame over ~8.3 ms waits for the next refresh and shows as a drop to 60, so
 * the question is always which frames miss and what they spent the time on:
 *
 *   - CPU, by section of the frame loop (simulation, world, effects, HUD, and
 *     the render call itself — which on WebGL is mostly draw submission);
 *   - GPU, measured with a timer query where the browser exposes one;
 *   - shader compiles (a new program mid-match is a classic hitch);
 *   - JS heap drops (garbage collection pauses, Chrome only);
 *   - and what is left over: a long frame interval with short CPU and GPU time
 *     is a stall outside the page (GC, compositor, another tab, the OS).
 *
 * The panel updates twice a second; the last few slow frames are kept with their
 * breakdown. Clicking the panel copies a plain-text report to the clipboard.
 */

import type * as THREE from 'three';

export const SECTIONS = ['sim', 'world', 'fx', 'hud', 'render'] as const;
export type Section = (typeof SECTIONS)[number];

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

type Spike = { at: number; interval: number; cpu: number; gpu: number | null; worst: string; programs: number };

const WINDOW_MS = 2000;
const SPIKE_LOG = 6;

export class FramePerf {
  private gl: WebGL2RenderingContext | null;
  private timer: TimerExt | null = null;
  private pendingQueries: WebGLQuery[] = [];
  private activeQuery: WebGLQuery | null = null;
  private lastGpu: number | null = null;

  private frameStart = 0;
  private sectionStart = 0;
  private current: Record<Section, number> = { sim: 0, world: 0, fx: 0, hud: 0, render: 0 };

  // Window accumulators.
  private windowStart = performance.now();
  private intervals: number[] = [];
  private cpuTotals: number[] = [];
  private gpuTotals: number[] = [];
  private sums: Record<Section, number> = { sim: 0, world: 0, fx: 0, hud: 0, render: 0 };
  private maxes: Record<Section, number> = { sim: 0, world: 0, fx: 0, hud: 0, render: 0 };
  private heapDrops = 0;
  private lastHeap = 0;
  private programsAtWindow = 0;
  private spikes: Spike[] = [];
  /** The display's refresh interval, learned from the fastest frames seen. */
  private refresh = 1000 / 60;
  /** Smoothed GPU frame time (ms), or null where the browser has no timer. */
  private gpuSmoothed: number | null = null;
  /** Smoothed frame interval (ms). */
  private intervalSmoothed = 1000 / 60;

  /** For dynamic resolution: smoothed GPU ms (null if unmeasurable). */
  get gpuMs(): number | null {
    return this.gpuSmoothed;
  }

  /** For dynamic resolution: the display's frame budget, ms. */
  get budgetMs(): number {
    return this.refresh;
  }

  /** For dynamic resolution: smoothed time between frames, ms. */
  get intervalMs(): number {
    return this.intervalSmoothed;
  }

  private report = '';

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly panel: HTMLElement | null,
  ) {
    const gl = renderer.getContext();
    this.gl = 'createQuery' in gl ? (gl as WebGL2RenderingContext) : null;
    this.timer = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
    this.programsAtWindow = this.programs();
    panel?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.report).then(
        () => panel.classList.add('copied'),
        () => undefined,
      );
      setTimeout(() => panel.classList.remove('copied'), 900);
    });
  }

  /** Is anyone looking? Measuring is cheap, but not free. */
  get enabled(): boolean {
    return document.body.classList.contains('debug-on');
  }

  begin(now: number): void {
    // Count the whole frame's draws: with post-processing (and the shadow pass)
    // there are several render() calls, and three.js resets the counters on each
    // by default — the panel then showed only the last pass ("1 calls").
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    this.frameStart = now;
    this.sectionStart = performance.now();
    for (const s of SECTIONS) this.current[s] = 0;
  }

  /** Close the running section and charge its time to `section`. */
  mark(section: Section): void {
    const t = performance.now();
    this.current[section] += t - this.sectionStart;
    this.sectionStart = t;
  }

  /** Bracket the render call with a GPU timer query, if there is one. */
  gpuBegin(): void {
    if (!this.gl || !this.timer || this.activeQuery) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    this.activeQuery = q;
  }

  gpuEnd(): void {
    if (!this.gl || !this.timer || !this.activeQuery) return;
    this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.pendingQueries.push(this.activeQuery);
    this.activeQuery = null;
  }

  /** End of frame. `interval` is the time since the previous frame began, ms. */
  end(interval: number): void {
    this.collectGpu();
    const cpu = SECTIONS.reduce((sum, s) => sum + this.current[s], 0);
    if (interval > 0) this.refresh = Math.min(this.refresh * 1.001, Math.max(interval, 1000 / 360));
    if (interval > 0 && interval < 250) this.intervalSmoothed += (interval - this.intervalSmoothed) * 0.1;
    if (this.lastGpu !== null) {
      this.gpuSmoothed = this.gpuSmoothed === null ? this.lastGpu : this.gpuSmoothed + (this.lastGpu - this.gpuSmoothed) * 0.1;
    }
    this.intervals.push(interval);
    this.cpuTotals.push(cpu);
    if (this.lastGpu !== null) this.gpuTotals.push(this.lastGpu);
    for (const s of SECTIONS) {
      this.sums[s] += this.current[s];
      this.maxes[s] = Math.max(this.maxes[s], this.current[s]);
    }

    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (memory) {
      if (memory.usedJSHeapSize < this.lastHeap - 1e6) this.heapDrops++;
      this.lastHeap = memory.usedJSHeapSize;
    }

    // A missed refresh: noticeably longer than the display's frame.
    if (interval > this.refresh * 1.5) {
      const worst = SECTIONS.reduce((a, b) => (this.current[a] >= this.current[b] ? a : b));
      this.spikes.push({
        at: this.frameStart,
        interval,
        cpu,
        gpu: this.lastGpu,
        worst: `${worst} ${this.current[worst].toFixed(1)}`,
        programs: this.programs(),
      });
      if (this.spikes.length > SPIKE_LOG) this.spikes.shift();
    }

    if (this.frameStart - this.windowStart >= WINDOW_MS) this.flush();
  }

  private collectGpu(): void {
    const gl = this.gl;
    const timer = this.timer;
    if (!gl || !timer) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
    while (this.pendingQueries.length > 0) {
      const q = this.pendingQueries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) this.lastGpu = ns / 1e6;
      gl.deleteQuery(q);
      this.pendingQueries.shift();
    }
    // Never let a driver that never answers grow the queue.
    while (this.pendingQueries.length > 8) gl.deleteQuery(this.pendingQueries.shift()!);
  }

  private programs(): number {
    return this.renderer.info.programs?.length ?? 0;
  }

  private flush(): void {
    const n = this.intervals.length || 1;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const avg = this.intervals.reduce((a, b) => a + b, 0) / n;
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
    const missed = this.intervals.filter((i) => i > this.refresh * 1.5).length;
    const cpuAvg = this.cpuTotals.reduce((a, b) => a + b, 0) / n;
    const cpuMax = Math.max(0, ...this.cpuTotals);
    const gpuAvg = this.gpuTotals.length ? this.gpuTotals.reduce((a, b) => a + b, 0) / this.gpuTotals.length : null;
    const gpuMax = this.gpuTotals.length ? Math.max(...this.gpuTotals) : null;
    const info = this.renderer.info.render;
    const programs = this.programs();
    const compiled = programs - this.programsAtWindow;

    const lines = [
      `display   ${(1000 / this.refresh).toFixed(0)} Hz (${this.refresh.toFixed(1)} ms budget)`,
      `fps       ${(1000 / avg).toFixed(0)} avg · 1% low ${(1000 / Math.max(p99, 0.001)).toFixed(0)} · missed ${missed}/${n}`,
      `frame     avg ${avg.toFixed(1)} ms · worst ${sorted[sorted.length - 1]?.toFixed(1) ?? '–'} ms`,
      `cpu       avg ${cpuAvg.toFixed(1)} · max ${cpuMax.toFixed(1)} ms`,
      `  ${SECTIONS.map((s) => `${s} ${(this.sums[s] / n).toFixed(1)}/${this.maxes[s].toFixed(1)}`).join('  ')}`,
      `gpu       ${gpuAvg === null ? 'n/a (no timer query in this browser)' : `avg ${gpuAvg.toFixed(1)} · max ${gpuMax!.toFixed(1)} ms`}`,
      `draws     ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · ${programs} shaders${compiled > 0 ? ` (+${compiled} compiled!)` : ''}`,
      `gc        ${(performance as unknown as { memory?: unknown }).memory ? `${this.heapDrops} heap drops` : 'n/a'}`,
      `pixels    ${this.renderer.domElement.width}×${this.renderer.domElement.height} @ ${this.renderer.getPixelRatio()}×`,
      'slow frames (interval / cpu / gpu / biggest section):',
      ...this.spikes
        .slice()
        .reverse()
        .map(
          (s) =>
            `  ${s.interval.toFixed(1)} / ${s.cpu.toFixed(1)} / ${s.gpu === null ? '–' : s.gpu.toFixed(1)} ms · ${s.worst}` +
            // Only claim "outside" when the GPU time is actually known to be short.
            (s.gpu !== null && s.cpu < this.refresh * 0.6 && s.gpu < this.refresh * 0.6 ? ' · outside JS/GPU' : ''),
        ),
    ];
    this.report = lines.join('\n');
    if (this.panel && this.enabled) this.panel.textContent = this.report;

    this.windowStart = this.frameStart;
    this.intervals = [];
    this.cpuTotals = [];
    this.gpuTotals = [];
    for (const s of SECTIONS) {
      this.sums[s] = 0;
      this.maxes[s] = 0;
    }
    this.heapDrops = 0;
    this.programsAtWindow = programs;
  }
}
