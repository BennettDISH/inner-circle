// In-memory counters for routes a script could hammer: wrong join-code guesses and Waypoint
// sign-in tries. One fixed window per key; a redeploy clears them, which is fine for limits
// measured in minutes and hours. Keys built from req.ip are the real client address only because
// server.js trusts exactly one proxy hop (Railway's edge).

// Stale windows are swept once the map gets this big, so a flood of keys can't grow it without
// bound.
const SWEEP_AT = 10000;

export function createLimiter({ max, windowMs }) {
  const windows = new Map(); // key -> { count, resetAt }

  function current(key, now) {
    const w = windows.get(key);
    if (w && w.resetAt <= now) {
      windows.delete(key);
      return undefined;
    }
    return w;
  }

  return {
    // True once `key` has used up its `max` in the current window.
    blocked(key) {
      return (current(key, Date.now())?.count ?? 0) >= max;
    },
    // Counts one use for `key`.
    hit(key) {
      const now = Date.now();
      const w = current(key, now);
      if (w) {
        w.count += 1;
        return;
      }
      if (windows.size >= SWEEP_AT) {
        for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
    },
  };
}
