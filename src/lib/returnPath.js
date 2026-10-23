// After signing in the visitor goes back to the page they asked for (e.g. /admin), but only to a
// page of this app: never another site, never the sign-in pages themselves.

// A page of this app to come back to, or '' when the path is not one.
export function safePath(path) {
  return typeof path === 'string' && /^\/(?![/\\])/.test(path) && !/^\/(login|register|auth\/)/.test(path) ? path : '';
}

// Remember the page across the trip to Waypoint (the sign-in leaves the app, so router state is lost).
export function saveSsoReturn(path) {
  const back = safePath(path);
  if (back) sessionStorage.setItem('sso_return', back);
}

// The page remembered by saveSsoReturn, read once on the way back; '/' when there is none.
export function takeSsoReturn() {
  const back = safePath(sessionStorage.getItem('sso_return'));
  sessionStorage.removeItem('sso_return');
  return back || '/';
}
