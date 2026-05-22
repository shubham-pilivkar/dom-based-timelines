// Tiny wrapper around chrome.runtime.sendMessage / onMessage that:
//   - normalises the success/error envelope so callers don't repeat
//     try/catch + chrome.runtime.lastError handling at every site
//   - swallows the harmless "Receiving end does not exist" error that
//     fires when nobody is listening (e.g. popup is closed) so it doesn't
//     spam the SW console.
//
// onMessage(typeMap) registers per-message-type handlers. Importantly,
// the underlying chrome.runtime.onMessage listener returns false
// SYNCHRONOUSLY when no handler is registered for a given message type.
// That stops the listener from racing other contexts to call
// sendResponse — a context that doesn't handle a message simply doesn't
// participate in the response. Without this, popup + offscreen would
// both respond to a relayed RETRY_MONITOR and the wrong answer could
// win.

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
// Fired when the sender context goes away before the async handler
// responds — classically when starting a flow whose SW handler opens
// a window (mic-permission), which closes the toolbar popup. This is
// BENIGN: the operation continues in the SW and its real outcome
// arrives via a state broadcast. Surface a stable code so callers
// don't render Chrome's raw "A listener indicated an asynchronous
// response…" string as a hard failure.
const CHANNEL_CLOSED = 'message channel closed';
const LISTENER_ASYNC = 'listener indicated an asynchronous response';

/**
 * Send a message and await the response. Returns { ok, data } on success
 * or { ok: false, error } on failure. Never throws.
 *
 * @param {{ type: string } & Record<string, unknown>} message
 * @returns {Promise<{ ok: true, data?: unknown } | { ok: false, error: string }>}
 */
export async function sendMessage(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response === undefined) {
      return { ok: true };
    }
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(NO_RECEIVER)) {
      return { ok: false, error: 'no_receiver' };
    }
    if (msg.includes(CHANNEL_CLOSED) || msg.includes(LISTENER_ASYNC)) {
      return { ok: false, error: 'channel_closed' };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Register message-type handlers. Two call shapes:
 *
 *   onMessage({ [MessageType.X]: handler, ... })  // recommended
 *   onMessage(handler)                            // legacy / catch-all
 *
 * The typeMap form returns `false` from the underlying chrome listener
 * for any message type not in the map, so unrelated broadcasts don't
 * race the actual recipient. Use the legacy form only when you need to
 * handle every message type (the SW's central router).
 *
 * @param {Record<string, (msg: any, sender: chrome.runtime.MessageSender) => unknown | Promise<unknown>> | ((msg: any, sender: chrome.runtime.MessageSender) => unknown | Promise<unknown>)} handlerOrMap
 */
export function onMessage(handlerOrMap) {
  const isMap = typeof handlerOrMap !== 'function';

  const listener = (message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    // Reject messages from other extensions. Internal messages always
    // carry our own runtime id; external extensions use a different one,
    // and externally_connectable would supply a `url` instead. We don't
    // expose any externally_connectable surface, so anything not from us
    // is unexpected and silently ignored.
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;

    let handler;
    if (isMap) {
      handler = handlerOrMap[message.type];
      if (!handler) return false; // not for me — yield the channel
    } else {
      handler = handlerOrMap;
    }

    Promise.resolve()
      .then(() => handler(message, sender))
      .then((result) => sendResponse({ ok: true, data: result }))
      .catch((err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Send a message to a specific tab (used for content-script lifecycle pings).
 *
 * @param {number} tabId
 * @param {{ type: string } & Record<string, unknown>} message
 */
export async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response ?? { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
