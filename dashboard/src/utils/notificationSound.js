// Plays a short chime when new transaction activity is detected, so the admin
// doesn't have to watch the dashboard. Uses the Web Audio API (synthesized
// tones — no asset file to ship) and persists a mute preference.
//
// Browsers block audio until the user has interacted with the page, so the
// AudioContext is created lazily and resumed on the first user gesture. Until
// then, playChime() is a no-op (no error).

const MUTE_KEY = 'aaas:txns:sound:muted';
export const SOUND_PREF_EVENT = 'aaas:txns:sound-changed';

let ctx = null;
let unlockBound = false;

export function isMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // localStorage unavailable — preference just won't persist.
  }
  try {
    window.dispatchEvent(new CustomEvent(SOUND_PREF_EVENT, { detail: { muted } }));
  } catch {
    // non-browser env — irrelevant.
  }
  // Unmuting is a user gesture — a good moment to unlock the AudioContext.
  if (!muted) ensureContext();
}

function ensureContext() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Resume the context on the first user interaction so later chimes can play
// even if the triggering event wasn't a user gesture (e.g. a poll tick).
export function bindAudioUnlock() {
  if (unlockBound || typeof window === 'undefined') return;
  unlockBound = true;
  const unlock = () => { ensureContext(); };
  window.addEventListener('pointerdown', unlock, { once: false, passive: true });
  window.addEventListener('keydown', unlock, { once: false, passive: true });
}

/**
 * Play a brief two-note chime. Pass severity 'alert' for a sharper, lower
 * tone (used for cancellations); anything else gets the default pleasant ping.
 */
export function playChime(severity = 'info') {
  if (isMuted()) return;
  const audio = ensureContext();
  if (!audio || audio.state !== 'running') return; // not unlocked yet

  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = 0.0001;
  master.connect(audio.destination);

  // Two short notes. Cancellations descend (attention); others ascend (pleasant).
  const notes = severity === 'alert'
    ? [[660, 0], [440, 0.14]]
    : [[784, 0], [1047, 0.12]];

  for (const [freq, offset] of notes) {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = now + offset;
    const dur = 0.16;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
  master.gain.value = 1;
}
