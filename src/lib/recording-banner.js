// On-page recording banner injected by content scripts. Shown while a
// recording is active. Privacy/consent best practice — an unambiguous
// "recording is on" indicator that mirrors the toolbar badge.
//
// The banner is DRAGGABLE: users asked to be able to move it off
// meeting controls. Position is persisted (chrome.storage.local) so it
// stays where the user put it across sessions/tabs. It defaults to the
// top-right corner.

const BANNER_ID = 'meetminutes-recording-banner';
const STYLE_ID = 'meetminutes-recording-style';
const POS_KEY = 'mm_banner_pos'; // { left:number, top:number } in px

function fmtElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// chrome.storage is available to content scripts but guard anyway so a
// missing namespace just means "don't persist" (banner still drags).
function loadPos() {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local) return resolve(null);
      chrome.storage.local.get(POS_KEY, (got) => {
        const p = got && got[POS_KEY];
        resolve(
          p && typeof p.left === 'number' && typeof p.top === 'number'
            ? p : null,
        );
      });
    } catch {
      resolve(null);
    }
  });
}
function savePos(pos) {
  try {
    chrome?.storage?.local?.set({ [POS_KEY]: pos });
  } catch {
    /* best-effort — drag still works without persistence */
  }
}

/**
 * @param {() => number} getElapsedSeconds  Provided by the content
 *   script — reads the SW-broadcast t0 anchor (now pause-aware) so the
 *   banner clock matches the toolbar popup, including freezing while
 *   the recording is paused.
 */
export function createRecordingBanner(getElapsedSeconds) {
  let el = null;
  let tickTimer = null;

  function clampToViewport(left, top, w, h) {
    const maxL = Math.max(0, window.innerWidth - (w || 160));
    const maxT = Math.max(0, window.innerHeight - (h || 32));
    return {
      left: Math.min(Math.max(0, left), maxL),
      top: Math.min(Math.max(0, top), maxT),
    };
  }

  function makeDraggable(node) {
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    node.addEventListener('pointerdown', (e) => {
      dragging = true;
      const r = node.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      node.style.cursor = 'grabbing';
      try { node.setPointerCapture(e.pointerId); } catch { /* ok */ }
      e.preventDefault();
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = node.getBoundingClientRect();
      const { left, top } = clampToViewport(
        ox + (e.clientX - sx), oy + (e.clientY - sy), r.width, r.height,
      );
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.right = 'auto';
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      node.style.cursor = 'grab';
      try { node.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      const r = node.getBoundingClientRect();
      savePos({ left: Math.round(r.left), top: Math.round(r.top) });
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  function ensure() {
    if (el && document.body.contains(el)) return el;
    el = document.createElement('div');
    el.id = BANNER_ID;
    // Inline styles — avoids a web_accessible CSS file and dodges
    // host-page rules. ``pointer-events:auto`` + ``cursor:grab`` so it
    // can be dragged (it was non-interactive before).
    el.setAttribute(
      'style',
      [
        'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
        'background:#dc2626', 'color:#fff',
        'font:600 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
        'padding:6px 10px', 'border-radius:999px',
        'box-shadow:0 2px 8px rgba(0,0,0,.35)',
        'display:flex', 'align-items:center', 'gap:8px',
        'pointer-events:auto', 'cursor:grab', 'user-select:none',
        'touch-action:none',
      ].join(';'),
    );
    el.title = 'Drag to move';
    // Meet/Teams enforce Trusted Types CSP — assigning a STRING to
    // innerHTML throws a TypeError (the banner then never appears).
    // Build via createElement; setAttribute('style', …) + textContent
    // are not Trusted-Types-restricted sinks.
    const dot = document.createElement('span');
    dot.setAttribute(
      'style',
      'width:8px;height:8px;border-radius:50%;background:#fff;'
      + 'animation:mm-pulse 1.4s ease-in-out infinite;pointer-events:none',
    );
    const txt = document.createElement('span');
    txt.setAttribute('data-mm-text', '');
    txt.setAttribute('style', 'pointer-events:none');
    txt.textContent = 'MeetMinutes • REC 00:00';
    el.append(dot, txt);
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent =
        '@keyframes mm-pulse{0%,100%{opacity:1}50%{opacity:.35}}';
      document.documentElement.appendChild(style);
    }
    document.body.appendChild(el);
    makeDraggable(el);
    // Restore a previously dragged position (async; harmless if late).
    void loadPos().then((p) => {
      if (!p || !el) return;
      const r = el.getBoundingClientRect();
      const { left, top } = clampToViewport(p.left, p.top, r.width, r.height);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = 'auto';
    });
    return el;
  }

  function tick() {
    if (!el) return;
    const t = el.querySelector('[data-mm-text]');
    if (t) t.textContent = `MeetMinutes • REC ${fmtElapsed(getElapsedSeconds())}`;
  }

  function show() {
    ensure();
    tick();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
  }

  // Immediate re-render — used when the recording pauses/resumes so the
  // frozen clock updates without waiting for the next 1s tick.
  function refresh() {
    tick();
  }

  function hide() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  return { show, hide, refresh };
}
