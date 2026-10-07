'use strict';

/**
 * Vercel serverless entrypoint — PRD §20.1, §21.2.
 *
 * The platform owns the listener, so this module MUST NOT call `app.listen()`.
 * `backend/server.js` exports the app and only listens when it is run directly
 * (`node backend/server.js`), so the same file is both the local dev server and
 * the deployed handler. That is deliberate: one Express app, one route table,
 * one behaviour — a second copy would be free to drift from the PRD.
 *
 * Routing (see vercel.json): `/api/*` and `/ks_core.wasm` are rewritten here;
 * everything else falls through to the built frontend.
 */
module.exports = require('../backend/server.js');
