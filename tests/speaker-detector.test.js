import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSpeakerDetector } from '../src/lib/speaker-detector.js';

describe('startSpeakerDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeProbe(initial) {
    const state = { tiles: initial };
    return {
      observeRoot: document.body,
      attributeFilter: ['class'],
      snapshot: () => state.tiles,
      set: (tiles) => {
        state.tiles = tiles;
      },
    };
  }

  it('debounces rapid speaker changes — only the steady speaker commits', () => {
    const onChange = vi.fn();
    let elapsed = 0;
    const probe = makeProbe([{ id: '1', name: 'Alice', speaking: true }]);

    const { evaluate, dispose } = startSpeakerDetector({
      probe,
      getElapsedSeconds: () => elapsed,
      onChange,
      isActive: () => true,
    });

    // Alice steady — first commit, no previous speaker so onChange stays silent.
    evaluate();
    elapsed = 0.3;
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();

    // Bob steady — Alice's segment closes out.
    probe.set([{ id: '1', name: 'Bob', speaking: true }]);
    evaluate();
    elapsed = 0.6;
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      speaker_name: 'Alice',
      start_time: 0.3,
      end_time: 0.6,
    });

    // Rapid Carol → Dave inside the debounce window — Carol must be dropped.
    probe.set([{ id: '1', name: 'Carol', speaking: true }]);
    evaluate();
    vi.advanceTimersByTime(100);

    probe.set([{ id: '1', name: 'Dave', speaking: true }]);
    evaluate();
    vi.advanceTimersByTime(100);

    elapsed = 1.0;
    vi.advanceTimersByTime(300);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({
      speaker_name: 'Bob',
      start_time: 0.6,
      end_time: 1.0,
    });

    dispose();
  });

  it('emits selectors_broken once after SELECTORS_BROKEN_MS of empty snapshots', () => {
    const onChange = vi.fn();
    const onTelemetry = vi.fn();
    // Probe always returns no tiles → simulates rotted selectors.
    const probe = makeProbe([]);

    const { dispose } = startSpeakerDetector({
      probe,
      getElapsedSeconds: () => 0,
      onChange,
      isActive: () => true,
      onTelemetry,
    });

    // Drive past the 30s threshold via the polling fallback's tick.
    vi.advanceTimersByTime(31_000);

    const calls = onTelemetry.mock.calls.filter((c) => c[0] === 'selectors_broken');
    expect(calls.length).toBe(1);
    // Subsequent ticks must not re-emit.
    vi.advanceTimersByTime(31_000);
    const calls2 = onTelemetry.mock.calls.filter((c) => c[0] === 'selectors_broken');
    expect(calls2.length).toBe(1);

    dispose();
  });
});
