// Tests for the heap watchdog used in offscreen.js + transcribe.js.
// The watchdog is pure-function with injectable ``getHeapBytes`` /
// ``getNow``, so we drive it through scripted heap-sample sequences
// without touching ``performance.memory``.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEAP_RECYCLE_BYTES,
  HEAP_RECYCLE_CONSECUTIVE_SAMPLES,
  HEAP_WATERMARK_BYTES,
  startHeapWatchdog,
} from '../src/lib/heap-watchdog.js';

function mb(n) {
  return n * 1024 * 1024;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});


describe('startHeapWatchdog — high water mark', () => {
  it('fires once per threshold as heap climbs', () => {
    let heap = mb(50);
    const high = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onHighWatermark: high,
    });

    wd.tick(); // 50 MB — below first threshold (100)
    expect(high).not.toHaveBeenCalled();

    heap = mb(120);
    wd.tick(); // crosses 100
    expect(high).toHaveBeenCalledTimes(1);
    expect(high.mock.calls[0][0].thresholdBytes).toBe(mb(100));

    heap = mb(150);
    wd.tick(); // still above 100 but not 200 — no new crossing
    expect(high).toHaveBeenCalledTimes(1);

    heap = mb(220);
    wd.tick(); // crosses 200
    expect(high).toHaveBeenCalledTimes(2);
    expect(high.mock.calls[1][0].thresholdBytes).toBe(mb(200));

    wd.stop();
  });

  it('does not re-fire when heap dips below then climbs above again', () => {
    // Stability matters more than perfect novelty here — re-emitting
    // would let a sawtooth heap pattern (e.g. GC cycles around the
    // threshold) spam the telemetry endpoint.
    let heap = mb(150);
    const high = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onHighWatermark: high,
    });

    wd.tick(); // crosses 100
    heap = mb(50);
    wd.tick(); // back below
    heap = mb(150);
    wd.tick(); // climbs again — should NOT re-fire

    expect(high).toHaveBeenCalledTimes(1);
    wd.stop();
  });
});


describe('startHeapWatchdog — sustained-high recycle', () => {
  it('fires recycle after N consecutive samples above threshold', () => {
    let heap = mb(300);
    const sustained = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onSustainedHigh: sustained,
    });

    for (let i = 0; i < HEAP_RECYCLE_CONSECUTIVE_SAMPLES - 1; i += 1) {
      wd.tick();
    }
    // Up to this point, recycle should NOT have fired — we're one
    // sample short.
    expect(sustained).not.toHaveBeenCalled();

    wd.tick(); // the Nth sample
    expect(sustained).toHaveBeenCalledTimes(1);
    expect(sustained.mock.calls[0][0].heapBytes).toBe(mb(300));
    expect(sustained.mock.calls[0][0].consecutiveSamples).toBe(
      HEAP_RECYCLE_CONSECUTIVE_SAMPLES,
    );

    wd.stop();
  });

  it('resets the streak when heap drops below threshold', () => {
    let heap = mb(300);
    const sustained = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onSustainedHigh: sustained,
    });

    // One high sample.
    wd.tick();
    expect(sustained).not.toHaveBeenCalled();
    // Heap drops — streak resets.
    heap = mb(100);
    wd.tick();
    expect(sustained).not.toHaveBeenCalled();
    // Single high again — needs N consecutive, not just any pair.
    heap = mb(300);
    wd.tick();
    expect(sustained).not.toHaveBeenCalled();

    wd.stop();
  });

  it('does not fire recycle twice in a row without a dip', () => {
    // Once we've fired recycle, the caller's action (rotate, close WS)
    // is in progress; we don't want a second fire on the very next
    // tick before the recycle has had time to drop the heap.
    let heap = mb(300);
    const sustained = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onSustainedHigh: sustained,
    });

    for (let i = 0; i < HEAP_RECYCLE_CONSECUTIVE_SAMPLES + 5; i += 1) {
      wd.tick();
    }
    expect(sustained).toHaveBeenCalledTimes(1);

    wd.stop();
  });
});


describe('startHeapWatchdog — robustness', () => {
  it('no-ops when getHeapBytes returns null (performance.memory missing)', () => {
    const high = vi.fn();
    const sustained = vi.fn();
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => null,
      onHighWatermark: high,
      onSustainedHigh: sustained,
    });
    wd.tick();
    wd.tick();
    expect(high).not.toHaveBeenCalled();
    expect(sustained).not.toHaveBeenCalled();
    wd.stop();
  });

  it('stop() clears the interval (no further ticks)', () => {
    const high = vi.fn();
    let heap = mb(150);
    const wd = startHeapWatchdog({
      intervalMs: 1000,
      getHeapBytes: () => heap,
      onHighWatermark: high,
    });

    vi.advanceTimersByTime(1000);
    expect(high).toHaveBeenCalledTimes(1);

    wd.stop();
    heap = mb(250);
    vi.advanceTimersByTime(5000);
    // No new high-watermark calls after stop.
    expect(high).toHaveBeenCalledTimes(1);
  });
});


describe('HEAP_WATERMARK_BYTES sanity', () => {
  it('is monotonically increasing', () => {
    for (let i = 1; i < HEAP_WATERMARK_BYTES.length; i += 1) {
      expect(HEAP_WATERMARK_BYTES[i]).toBeGreaterThan(HEAP_WATERMARK_BYTES[i - 1]);
    }
  });

  it('recycle threshold sits between the second and third watermark', () => {
    // Picked so we get a "this is getting bad" warning before we
    // recycle. Test pins the relationship so a tuning change has to
    // explicitly update this expectation.
    expect(HEAP_RECYCLE_BYTES).toBeGreaterThan(HEAP_WATERMARK_BYTES[1]);
    expect(HEAP_RECYCLE_BYTES).toBeLessThanOrEqual(HEAP_WATERMARK_BYTES[2]);
  });
});
