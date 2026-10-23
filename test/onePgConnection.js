// Preloaded into the app under test (node --import ./test/onePgConnection.js server.js): the
// app's database pool opens one connection. PGlite is a single session behind the socket
// server, which only multiplexes the connections' messages; when several requests arrive at once
// each takes its own connection and they can be handed each other's replies (a 401 "User not
// found" for an account that exists, in "keeps four even when uploads race for the last place").
// With one connection the requests queue on the pool instead and every reply goes to its asker.
import pg from 'pg';

const { Pool } = pg;
pg.Pool = class OneConnectionPool extends Pool {
  constructor(options) {
    super({ ...options, max: 1 });
  }
};
