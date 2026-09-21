/**
 * Request pointer lock without allowing browser policy/focus failures to abort
 * a game-state transition. Chromium may either throw synchronously or reject a
 * promise when the document is not focused or the element belongs to a stale
 * document; both cases should leave the menu/game flow usable.
 */
export function requestPointerLockSafely(element: HTMLElement): void {
  if (!element.requestPointerLock) return;
  try {
    void element.requestPointerLock().catch(() => undefined);
  } catch {
    // A later canvas click can retry once the document has focus.
  }
}
