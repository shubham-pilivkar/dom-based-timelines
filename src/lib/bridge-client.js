// WebSocket client for the optional MeetMinutes Desktop speaker-id bridge.
//
// The desktop app exposes a loopback WebSocket server (see
// recorder/speaker_id/bridge_server.py) when its "Identify speakers in
// transcripts" Settings toggle is on. When paired with this extension,
// every SPEAKER_CHANGE event from the Meet / Teams content scripts is
// forwarded to that server, so the desktop's transcript can replace
// "Speaker A/B/C" labels with real participant names.
//
// Connection model
// ----------------
//   * The desktop binds the first free port in BRIDGE_PORT_RANGE; the
//     extension probes them in order. Discord uses the same pattern for
//     its desktop client / web app handshake.
//   * First WS frame is `{"type":"pair","token":...,"source":"auto"}`.
//     The server replies `{"type":"paired"}` on success or
//     `{"type":"error","reason":"invalid_token"}` then closes.
//   * After pair, each `speaker_change` frame carries its own `source`
//     (google_meet / ms_teams) so one bridge connection can multiplex
//     events from both Meet and Teams tabs.
//   * Failures are fire-and-forget; the extension's IndexedDB timeline
//     remains the durable path. A dropped connection schedules a
//     backoff reconnect — the user shouldn't have to nurse the bridge.

import {
  BRIDGE_CONNECT_TIMEOUT_MS,
  BRIDGE_PORT_RANGE,
  BRIDGE_RECONNECT_BASE_MS,
  BRIDGE_RECONNECT_MAX_MS,
} from '../constants.js';

/** @typedef {'idle'|'connecting'|'paired'|'failed'} BridgeStatus */

/**
 * @typedef {Object} BridgeStatusSnapshot
 * @property {boolean} enabled
 * @property {boolean} paired
 * @property {number|null} port            Bound port iff paired.
 * @property {BridgeStatus} status         Coarse state for the options page badge.
 * @property {string} lastError            Last connect / pair failure reason ("" if none).
 */

export class BridgeClient {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {string} */
    this._token = '';
    /** @type {boolean} */
    this._enabled = false;
    /** @type {number|null} */
    this._port = null;
    /** @type {BridgeStatus} */
    this._status = 'idle';
    /** @type {string} */
    this._lastError = '';

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._reconnectTimer = null;
    /** @type {number} */
    this._reconnectDelay = BRIDGE_RECONNECT_BASE_MS;
    /** @type {boolean} */
    this._connectInFlight = false;

    /** @type {((paired: boolean) => void)|null} */
    this._onPairedChange = null;
  }

  /**
   * Register a callback that fires whenever the pair state flips. Used
   * by the SW to drive ``BRIDGE_LIFECYCLE`` to content scripts —
   * detection turns on when a pair lands, off when it drops.
   *
   * @param {(paired: boolean) => void} fn
   */
  onPairedChange(fn) {
    this._onPairedChange = fn;
  }

  /**
   * Apply the latest options-page configuration. Idempotent: identical
   * config is a no-op. Transitions:
   *
   *   enabled true   + token set      → start probing
   *   enabled true   + token unset    → disconnect, idle
   *   enabled false  (any token)      → disconnect, idle
   *   enabled true   + token changed  → disconnect, re-pair with new token
   *
   * @param {{enabled: boolean, token: string}} config
   */
  setConfig({ enabled, token }) {
    const tokenChanged = token !== this._token;
    const enableChanged = enabled !== this._enabled;
    this._enabled = !!enabled;
    this._token = token || '';
    if (!this._enabled || !this._token) {
      this._teardown();
      this._setStatus('idle');
      this._lastError = '';
      return;
    }
    if (tokenChanged || enableChanged) {
      // Forget any cached failure; new credentials get a fresh probe.
      this._teardown();
      this._reconnectDelay = BRIDGE_RECONNECT_BASE_MS;
      this._lastError = '';
      // Loopback hosts are declared in ``host_permissions`` (granted
      // at install), so we can dial directly — no runtime permission
      // request needed. (They live in host_permissions, NOT
      // optional_host_permissions, so the desktop bridge works out of
      // the box; moving them to optional broke the bridge.)
      this._tryConnect();
    }
  }

  /**
   * Forward one speaker event to the bridge. Best-effort: silently
   * dropped when not paired or the socket buffer is wedged.
   *
   * @param {{ wall_clock_ms: number, speaker_name: string,
   *           source: 'google_meet'|'ms_teams',
   *           start_time?: number|null, end_time?: number|null }} ev
   */
  send(ev) {
    if (this._status !== 'paired' || !this._ws) return;
    if (this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify({
        type: 'speaker_change',
        wall_clock_ms: ev.wall_clock_ms,
        speaker_name: ev.speaker_name,
        source: ev.source,
        start_time: ev.start_time ?? null,
        end_time: ev.end_time ?? null,
      }));
    } catch {
      // WebSocket may already be tearing down; the onclose handler
      // schedules a reconnect.
    }
  }

  /** @returns {BridgeStatusSnapshot} */
  getStatus() {
    return {
      enabled: this._enabled,
      paired: this._status === 'paired',
      port: this._port,
      status: this._status,
      lastError: this._lastError,
    };
  }

  /**
   * Manually trigger a connect attempt. Used by the options page's
   * "Test connection" button.
   */
  reconnectNow() {
    if (!this._enabled || !this._token) return;
    if (this._connectInFlight) return;
    this._teardown();
    this._reconnectDelay = BRIDGE_RECONNECT_BASE_MS;
    this._lastError = '';
    this._tryConnect();
  }

  // ---- internals ---------------------------------------------------

  _setStatus(s) {
    const wasPaired = this._status === 'paired';
    this._status = s;
    const isPaired = s === 'paired';
    if (wasPaired !== isPaired && this._onPairedChange) {
      try { this._onPairedChange(isPaired); } catch { /* noop */ }
    }
  }

  async _tryConnect() {
    if (this._connectInFlight) return;
    this._connectInFlight = true;
    this._setStatus('connecting');
    try {
      for (const port of BRIDGE_PORT_RANGE) {
        const ws = await this._dialAndPair(port);
        if (ws) {
          this._adoptPaired(ws, port);
          return;
        }
      }
      // Whole range exhausted — schedule retry. Specific port errors
      // were already captured into _lastError by _dialAndPair.
      this._setStatus('failed');
      if (!this._lastError) {
        this._lastError = `all ports busy (${BRIDGE_PORT_RANGE[0]}-${BRIDGE_PORT_RANGE.at(-1)})`;
      }
      this._scheduleReconnect();
    } finally {
      this._connectInFlight = false;
    }
  }

  /**
   * Open a WS to a single port and complete the pair handshake.
   * Resolves with the connected socket on success, or null on any
   * failure (the loop in ``_tryConnect`` falls through to the next).
   *
   * @param {number} port
   * @returns {Promise<WebSocket|null>}
   */
  _dialAndPair(port) {
    return new Promise((resolve) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      } catch (e) {
        this._lastError = `connect_throw: ${e instanceof Error ? e.message : String(e)}`;
        resolve(null);
        return;
      }

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result === null) {
          try { ws.close(); } catch { /* noop */ }
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        this._lastError = `timeout on port ${port}`;
        finish(null);
      }, BRIDGE_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: 'pair',
            token: this._token,
            source: 'auto',
          }));
        } catch (e) {
          this._lastError = `pair_send_failed: ${String(e)}`;
          finish(null);
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          this._lastError = 'unexpected_pair_response';
          finish(null);
          return;
        }
        if (msg && msg.type === 'paired') {
          this._lastError = '';
          finish(ws);
        } else if (msg && msg.type === 'error') {
          this._lastError = `pair_rejected: ${msg.reason || 'unknown'}`;
          finish(null);
        }
      };

      ws.onerror = () => {
        // No useful detail in the WS error event — assume server isn't
        // listening on this port and move on. The specific failure
        // (refused vs reset) doesn't change behaviour.
        if (!this._lastError) this._lastError = `connect_failed on port ${port}`;
        finish(null);
      };

      ws.onclose = () => {
        // Closed before paired counts as a failure for this port.
        finish(null);
      };
    });
  }

  _adoptPaired(ws, port) {
    this._ws = ws;
    this._port = port;
    this._reconnectDelay = BRIDGE_RECONNECT_BASE_MS;
    this._setStatus('paired');
    // Replace the handshake handlers with steady-state ones.
    ws.onmessage = () => {
      // Bridge currently doesn't push the extension anything after pair;
      // ignore any frames silently rather than churn on parse errors.
    };
    ws.onclose = () => {
      this._ws = null;
      this._port = null;
      if (this._status === 'paired') {
        // Lost an established connection — log and retry.
        if (!this._lastError) this._lastError = 'desktop_disconnected';
        this._setStatus('failed');
      }
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      // Errors after pair surface as close — let onclose handle it.
    };
  }

  _scheduleReconnect() {
    if (!this._enabled || !this._token) return;
    if (this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(
      this._reconnectDelay * 2, BRIDGE_RECONNECT_MAX_MS,
    );
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._tryConnect();
    }, delay);
  }

  _teardown() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch { /* noop */ }
      this._ws = null;
    }
    this._port = null;
    if (this._status === 'paired') this._setStatus('idle');
  }
}
