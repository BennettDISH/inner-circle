// Express 4 does not catch a rejected promise from an async route handler: the request hangs
// and Node exits on the unhandled rejection, so one bad request took the whole server down.
// wrap() hands the error to Express instead, which sends it to the error handler in server.js.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
