// Bug 13.1 — WS listener cleanup via AbortController.
//
// In live-transcribe, each substream's WebSocket has four event
// listeners (open / message / error / close) whose closures retain
// references to ``sess``, ``pendingFrames``, and the heartbeat timer.
// Without explicit cleanup, those closures sat attached to the WS
// after ``ws.close()`` until Chrome's WS finalizer ran — blocking
// GC of the MediaStream / AudioContext on the substream.
//
// Modern (2026-spec) pattern: pass ``{signal: controller.signal}`` as
// the third arg to ``addEventListener``; a single ``controller.abort()``
// blanket-detaches all four. Source-contract tests below verify the
// wiring in ``offscreen/transcribe.js``.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const off = readFileSync(
  resolve(here, '../src/offscreen/transcribe.js'),
  'utf8',
);

describe('attachWebSocket — AbortController setup', () => {
  it('creates a fresh AbortController per WS attach', () => {
    const idx = off.indexOf('function attachWebSocket(');
    expect(idx).toBeGreaterThan(-1);
    // The first ~1200 chars of attachWebSocket cover the controller
    // setup + opts object. Generous slice — the function header has
    // long explanatory comments.
    const fn = off.slice(idx, idx + 2200);
    expect(fn).toMatch(/const\s+wsAbort\s*=\s*new\s+AbortController\(\)/);
    expect(fn).toMatch(/sess\.wsAbort\s*=\s*wsAbort/);
  });

  it('aborts the prior controller before overwriting (reconnect path)', () => {
    // The reconnect path re-enters attachWebSocket for the same
    // ``sess`` object. Without this abort, the OLD controller's
    // four listeners stay attached until WS GC. With it, listeners
    // detach immediately on the reconnect handoff.
    const idx = off.indexOf('function attachWebSocket(');
    const fn = off.slice(idx, idx + 2200);
    expect(fn).toMatch(/if\s*\(\s*sess\.wsAbort\s*\)/);
    expect(fn).toMatch(/sess\.wsAbort\.abort\(\)/);
  });

  it('exposes wsListenerOpts as the shared third arg', () => {
    const idx = off.indexOf('function attachWebSocket(');
    const fn = off.slice(idx, idx + 2200);
    expect(fn).toMatch(
      /const\s+wsListenerOpts\s*=\s*\{\s*signal:\s*wsAbort\.signal\s*\}/,
    );
  });
});

describe('attachWebSocket — every listener registered with the signal', () => {
  // Each of the four WS listeners must pass ``wsListenerOpts`` so
  // the abort blanket-removes them. Missing one means abort doesn't
  // detach that handler — its closure retains references and the
  // bug regresses for that path.

  it('open handler passes wsListenerOpts', () => {
    // Each listener closes with ``});`` at the end of its arrow
    // function. The signal-wrapped form is ``}, wsListenerOpts);``
    // — grep the source for that suffix and require ALL four.
    const matches = off.match(/\}, wsListenerOpts\);/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('open handler in particular ends with wsListenerOpts', () => {
    const openIdx = off.indexOf("ws.addEventListener('open',");
    expect(openIdx).toBeGreaterThan(-1);
    // The next 1500 chars cover the open handler body.
    const body = off.slice(openIdx, openIdx + 1500);
    expect(body).toMatch(/\}, wsListenerOpts\);/);
  });

  it('message handler ends with wsListenerOpts', () => {
    const idx = off.indexOf("ws.addEventListener('message',");
    expect(idx).toBeGreaterThan(-1);
    // Message handler is the largest — give it 4000 chars.
    const body = off.slice(idx, idx + 4000);
    expect(body).toMatch(/\}, wsListenerOpts\);/);
  });

  it('error handler ends with wsListenerOpts', () => {
    const idx = off.indexOf("ws.addEventListener('error',");
    expect(idx).toBeGreaterThan(-1);
    const body = off.slice(idx, idx + 600);
    expect(body).toMatch(/\}, wsListenerOpts\);/);
  });

  it('close handler ends with wsListenerOpts', () => {
    const idx = off.indexOf("ws.addEventListener('close',");
    expect(idx).toBeGreaterThan(-1);
    // Close handler is the LARGEST of the four (~3400 chars with the
    // reconnect-decision comments + immediate-drop-fatal guard).
    const body = off.slice(idx, idx + 3600);
    expect(body).toMatch(/\}, wsListenerOpts\);/);
  });
});

describe('tearDown — aborts controller alongside ws.close()', () => {
  it('calls sess.wsAbort.abort() in the per-substream cleanup loop', () => {
    const idx = off.indexOf('async function tearDown(');
    expect(idx).toBeGreaterThan(-1);
    // The full tearDown body is ~80 lines.
    const fn = off.slice(idx, idx + 4000);
    expect(fn).toMatch(/s\.wsAbort/);
    expect(fn).toMatch(/s\.wsAbort\.abort\(\)/);
  });

  it('clears sess.wsAbort after abort so a stale reference doesn\'t survive', () => {
    const idx = off.indexOf('async function tearDown(');
    const fn = off.slice(idx, idx + 4000);
    expect(fn).toMatch(/s\.wsAbort\s*=\s*null/);
  });

  it('abort is wrapped in try/catch (idempotent re-aborts must not throw)', () => {
    const idx = off.indexOf('async function tearDown(');
    const fn = off.slice(idx, idx + 4000);
    // The pattern ``try { s.wsAbort.abort(); } catch { ... }``
    // protects against double-tearDown or a stale handle.
    expect(fn).toMatch(/try\s*\{\s*s\.wsAbort\.abort\(\);\s*\}/);
  });

  it('ws.close() is still called too — abort removes listeners only, not the resource', () => {
    const idx = off.indexOf('async function tearDown(');
    const fn = off.slice(idx, idx + 4000);
    // Both cleanups must coexist: ``ws.close()`` for the socket
    // resource, ``wsAbort.abort()`` for the listener references.
    expect(fn).toMatch(/s\.ws\.close\(\s*1000/);
    expect(fn).toMatch(/s\.wsAbort\.abort\(\)/);
  });
});
