/**
 * MoL-Bench determinism contract, v1.
 *
 * The harness injects `window.__benchHost` BEFORE any room script runs.
 * Every submission MUST expose `window.__bench` implementing `BenchRoom`.
 *
 * Rules:
 *  - Use `__benchHost.clock.now()` for all animation time. Do not drive animation from
 *    Date.now(), performance.now() or per-frame increments.
 *  - Use `__benchHost.rng` for all randomness that affects pixels or state.
 *  - After `setSeed(s)` + `seek(t)` + `await renderFrame()`, the presented frame must be a pure
 *    function of (seed, t, viewport, pointer, media features). The harness renders twice and
 *    compares SHA-256 of the pixels (gate G-determinism), and compares a seek frame against a
 *    live frame at the same clock (gate G-live).
 *  - DOM-only rooms implement the same interface; `renderFrame()` resolves after layout and paint.
 */

export interface BenchClock {
  /** Milliseconds since room start. Frozen while seeking; advances in live mode. */
  now(): number;
}

export interface BenchRng {
  /** Uniform float in [0, 1). Deterministic sequence per seed. */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Independent deterministic stream, e.g. rng.fork("stars"). */
  fork(label: string): BenchRng;
}

export interface BenchHost {
  readonly contractVersion: 1;
  readonly seed: number;
  /** Room parameters produced by the room's generator from the seed (see spec.json "generator"). */
  readonly params: Readonly<Record<string, unknown>>;
  readonly clock: BenchClock;
  readonly rng: BenchRng;
}

export interface BenchStats {
  drawCalls: number;
  triangles: number;
  /** Live GPU resources (WebGL rooms). Must return to baseline after unmount. */
  geometries?: number;
  textures?: number;
  programs?: number;
  particles?: number;
  /** Event listeners currently registered by the room (harness also counts independently). */
  listeners?: number;
}

export interface BenchRoom {
  readonly version: 1;
  /** Resolves when all assets are loaded and the first frame can be rendered. */
  readonly ready: Promise<void>;
  /** Reset ALL state (scene, rng streams, animation) to the given seed. */
  setSeed(seed: number): void;
  /** Freeze the clock at tMs (ms since start) and pause the live loop. */
  seek(tMs: number): void;
  /** Return to the live clock (continuing from the current clock value). */
  resume(): void;
  /** Resolves after the frame for the current clock has been presented. */
  renderFrame(): Promise<void>;
  /** Room-specific observable state used by hidden tests (see each spec's "state_contract"). */
  state(): Record<string, unknown>;
  stats(): BenchStats;
  /** Optional: mount/unmount for lifecycle tests (rooms that are entered/left). */
  mount?(container: HTMLElement): Promise<void>;
  unmount?(): Promise<void>;
}

declare global {
  interface Window {
    __benchHost: BenchHost;
    __bench: BenchRoom;
  }
}
