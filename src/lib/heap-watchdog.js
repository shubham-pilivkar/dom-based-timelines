// Periodic heap sampling for long-running sessions in the offscreen
// document. Chrome quantises ``performance.memory.usedJSHeapSize`` to
// 8 MB increments in regular tabs, but inside extension contexts the
// value is accurate (per Chrome docs). We use it as a cheap "is this
// session leaking?" signal and trigger a proactive recycle when the
// heap looks like it's growing without bound.
//
// Two signals come out of here:
//
//   * ``high_water_mark`` — emitted each time the heap crosses one of
//     the configured thresholds for the first time in this session.
//     One-shot per threshold so a stable session at, say, 180 MB
//     doesn't spam an event every minute.
//
//   * ``sustained_high`` — emitted when N consecutive samples exceed
//     the recycle threshold. The caller wires this to a recycle path
//     (rotateAudioContext for recording, ws.close(4002) for
//     live-transcribe) which drops the holding objects so GC can
//     reclaim them.
//
// Designed for testability: ``getHeapBytes`` and ``getNow`` are
// injectable so unit tests can drive the watchdog without
// ``performance.memory``.

// Crossing markers emitted via ``high_water_mark``. Picked at common
// MV3 heap inflection points: 100 MB is "comfortable", 200 MB is
// "watch this", 300 MB is "tab is going to thrash soon". Exporting
// for tests and for the SW's downstream classifier.
export const HEAP_WATERMARK_BYTES = Object.freeze([
  100 * 1024 * 1024,
  200 * 1024 * 1024,
  300 * 1024 * 1024,
]);

// Recycle threshold + how many consecutive samples above it trigger
// the recycle. 2 × 60s = 2 minutes of >250 MB is "this is real, not
// a transient allocation spike"; lower than that produced false
// positives in the bench.
export const HEAP_RECYCLE_BYTES = 250 * 1024 * 1024;
export const HEAP_RECYCLE_CONSECUTIVE_SAMPLES = 2;

// Default sample cadence — 60s is the sweet spot. Faster and we burn
// CPU on a stable session; slower and a leaking session goes too far
// before recycle.
export const HEAP_SAMPLE_INTERVAL_MS = 60_000;


/**
 * Start a heap-watchdog timer. Returns a ``stop()`` function that
 * cleans up the interval. Safe to call when ``performance.memory``
 * isn't available — silently no-ops.
 *
 * @param {{
 *   intervalMs?: number,
 *   recycleBytes?: number,
 *   recycleConsecutiveSamples?: number,
 *   watermarks?: number[],
 *   getHeapBytes?: () => (number | null),
 *   getNow?: () => number,
 *   onHighWatermark?: (info: { thresholdBytes: number, heapBytes: number, atMs: number }) => void,
 *   onSustainedHigh?: (info: { heapBytes: number, consecutiveSamples: number, atMs: number }) => void,
 * }} opts
 * @returns {{ stop: () => void, tick: () => void }}
 */
export function startHeapWatchdog(opts = {}) {
  const intervalMs = opts.intervalMs ?? HEAP_SAMPLE_INTERVAL_MS;
  const recycleBytes = opts.recycleBytes ?? HEAP_RECYCLE_BYTES;
  const recycleConsecutiveSamples =
    opts.recycleConsecutiveSamples ?? HEAP_RECYCLE_CONSECUTIVE_SAMPLES;
  const watermarks = opts.watermarks ?? HEAP_WATERMARK_BYTES;
  const getHeapBytes = opts.getHeapBytes ?? _defaultGetHeapBytes;
  const getNow = opts.getNow ?? (() => Date.now());

  const crossedWatermarks = new Set();
  let consecutiveHigh = 0;
  // Latch so we don't re-trigger the recycle callback every tick once
  // the threshold's been crossed — caller's recycle action breaks the
  // holding objects asynchronously, and a few extra ticks at high
  // heap during that window are expected.
  let recycleAlreadyFired = false;

  function tick() {
    const heapBytes = getHeapBytes();
    if (heapBytes === null || !Number.isFinite(heapBytes)) return;

    const atMs = getNow();
    for (const threshold of watermarks) {
      if (heapBytes >= threshold && !crossedWatermarks.has(threshold)) {
        crossedWatermarks.add(threshold);
        opts.onHighWatermark?.({ thresholdBytes: threshold, heapBytes, atMs });
      }
    }

    if (heapBytes >= recycleBytes) {
      consecutiveHigh += 1;
      if (
        consecutiveHigh >= recycleConsecutiveSamples
        && !recycleAlreadyFired
      ) {
        recycleAlreadyFired = true;
        opts.onSustainedHigh?.({
          heapBytes,
          consecutiveSamples: consecutiveHigh,
          atMs,
        });
      }
    } else {
      consecutiveHigh = 0;
      // Once heap returns below the threshold for a full tick, allow
      // the recycle to fire again on the next sustained climb.
      recycleAlreadyFired = false;
    }
  }

  const handle = setInterval(tick, intervalMs);
  return {
    stop: () => clearInterval(handle),
    // Exposed for tests so they can drive ticks deterministically
    // without waiting on setInterval.
    tick,
  };
}


function _defaultGetHeapBytes() {
  if (typeof performance === 'undefined') return null;
  const mem = /** @type {any} */ (performance).memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
  return mem.usedJSHeapSize;
}
