// Tracks the last-seen transaction timestamp per workspace in localStorage so
// the sidebar can show an "unseen new transactions" badge that resets when the
// user opens the Transactions tab.
//
// Storage shape:
//   aaas:txns:lastSeen:<workspace || 'standalone'> = <ISO timestamp>
//
// Cross-component updates: setLastSeen fires a CustomEvent on window so the
// sidebar hook can clear the badge instantly without waiting for its next
// poll tick.

const PREFIX = 'aaas:txns:lastSeen:';
export const SEEN_EVENT = 'aaas:txns:seen-changed';

function key(workspace) {
  return PREFIX + (workspace || 'standalone');
}

export function getLastSeen(workspace) {
  try {
    return localStorage.getItem(key(workspace));
  } catch {
    return null;
  }
}

export function setLastSeen(workspace, ts) {
  const value = ts || new Date().toISOString();
  try {
    localStorage.setItem(key(workspace), value);
  } catch {
    // localStorage unavailable (private mode, quota) — swallow; badge will
    // simply not persist across reloads.
  }
  try {
    window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: { workspace } }));
  } catch {
    // window/CustomEvent unavailable in non-browser env — irrelevant here.
  }
  return value;
}
