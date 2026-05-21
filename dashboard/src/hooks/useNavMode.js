import { createContext, useContext, useState, useEffect } from 'react';

/**
 * Navigation mode toggle — per workspace.
 *
 * Two values per workspace:
 *   - 'admin' (default): full sidebar with all categories.
 *   - 'basic': flat sidebar with only day-to-day pages, for non-technical
 *     operators (e.g. restaurant staff).
 *
 * Stored in localStorage as a JSON dictionary under `aaas-nav-modes`. Each
 * workspace gets its own key — flipping Basic on one restaurant doesn't
 * affect another shop in the same hub. Standalone mode (no workspaces)
 * uses the synthetic key `_standalone`.
 *
 * Storage shape:
 *   { "my-restaurant": "basic", "my-shop": "admin", "_standalone": "admin" }
 *
 * Provider API:
 *   value: { getMode(workspaceKey), setMode(workspaceKey, mode) }
 *
 * Convenience hook:
 *   useNavMode(workspaceKey) → { navMode, setNavMode } (mode + setter
 *   already bound to that workspace).
 */

const STORAGE_KEY = 'aaas-nav-modes';
export const STANDALONE_KEY = '_standalone';

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* ignore */ }
}

export const NavModeContext = createContext({
  getMode: () => 'admin',
  setMode: () => {},
});

export function useNavModeStore() {
  const [store, setStore] = useState(readStore);

  useEffect(() => {
    writeStore(store);
  }, [store]);

  const getMode = (workspaceKey) => {
    const key = workspaceKey || STANDALONE_KEY;
    return store[key] === 'basic' ? 'basic' : 'admin';
  };

  const setMode = (workspaceKey, mode) => {
    const key = workspaceKey || STANDALONE_KEY;
    const next = mode === 'basic' ? 'basic' : 'admin';
    setStore(prev => ({ ...prev, [key]: next }));
  };

  return { getMode, setMode };
}

/**
 * Per-workspace convenience hook. Bind the mode + setter to a specific
 * workspace key — null/undefined means standalone.
 */
export function useNavMode(workspaceKey) {
  const ctx = useContext(NavModeContext);
  const navMode = ctx.getMode(workspaceKey);
  const setNavMode = (mode) => ctx.setMode(workspaceKey, mode);
  return { navMode, setNavMode };
}
