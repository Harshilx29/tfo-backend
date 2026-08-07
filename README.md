# Track Manager Backend — Cloudflare Workers port

Rewrite of `tfo-backend` (Express + socket.io) to run on Cloudflare Workers
(Hono + Durable Objects). Goal was feature parity — see below for what's
identical, what's redesigned, and what's still manual work.

## What ported unchanged
- **Supabase queries and business logic** — `@supabase/supabase-js` is
  fetch/WebSocket-based, not a raw TCP driver, so it runs on Workers as-is.
  All the `.from(...).select(...)` calls in your routes are untouched.
- **Auth/permission logic** — `verifyJWT`, `verifyJWTOrTemp`,
  `requirePermission`, `requireReadAccess`, `requireAdmin` are the same
  checks, just moved from `(req, res, next)` to Hono's `(c, next)`.
- **Cookie signing scheme** — still `cookie-signature`'s `s:` format, via
  the `nodejs_compat` flag in `wrangler.toml`. Cookies issued by the old
  backend will still validate against the new one if you deploy with the
  same `SESSION_SECRET`.
- **create_temp_link.ts / test_company.ts** — these are local dev scripts,
  not part of the deployed server. Leave them running with `tsx`/`node`
  exactly as before; nothing to change.

## What was genuinely redesigned (not just ported)
1. **Express → Hono.** Workers don't run Node's `http` server model at
   all, so this swap was mandatory. Route signatures are structurally
   similar (`router.get('/x', middleware, handler)`), but every handler
   body needed `req`/`res` calls translated to `c.req`/`c.json(...)`.
2. **socket.io → Durable Object + native WebSockets**
   (`src/do/RealtimeRoom.ts`). Workers can't run a socket.io server.
   The DO holds the room membership (in-memory `Map`, mirrors socket.io's
   rooms) and the persistent outbound Supabase Realtime subscription that
   used to live in `ws/realtime.ts`. **Your frontend needs to switch from
   `socket.io-client` to a plain `WebSocket`** — see below.
3. **express-rate-limit → Cloudflare Rate Limiting binding**
   (`src/middleware/rateLimit.ts`). The old limiter's in-memory counters
   assumed one long-lived process; Workers doesn't guarantee that, so
   counting moved to Cloudflare's edge-native rate limiter.
4. **PKCE crypto: Node's `crypto` → Web Crypto API** in `routes/auth.ts`.
   Cleaner than relying on `nodejs_compat` for this one spot since Web
   Crypto (`crypto.subtle`, `crypto.getRandomValues`) is native to Workers.
5. **Error file logging removed.** The old callback handler wrote failures
   to `error_log.txt` — no filesystem on Workers. Errors now go to
   `console.error`, visible via `wrangler tail` or the dashboard Logs tab.

## Frontend changes needed
Replace `socket.io-client` with a native WebSocket to `wss://your-worker.workers.dev/realtime`:

```ts
const ws = new WebSocket(`${WS_BASE_URL}/realtime${tempToken ? `?tempToken=${tempToken}` : ''}`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'rt_track_change': /* ... */ break;
    case 'track_update': /* ... */ break;
    case 'companies_update': /* ... */ break;
    case 'yarns_update': /* ... */ break;
    case 'cop_colors_update': /* ... */ break;
    case 'profile_update': /* ... */ break;
    case 'permissions_update': /* ... */ break;
    case 'track_access_revoked': /* ... */ break;
    case 'company_access_revoked': /* ... */ break;
    case 'yarn_access_revoked': /* ... */ break;
  }
};
// Replaces socket.emit('join-track', uid) / socket.emit('leave-track', uid):
ws.send(JSON.stringify({ type: 'join-track', uid }));
ws.send(JSON.stringify({ type: 'leave-track', uid }));
```

Auth on connect relies on the `tm_access` httpOnly cookie being sent
automatically by the browser on the WebSocket handshake (same-origin or
CORS-with-credentials, same as your existing cookie setup) — no client
code needed for that part.

## Routes — all ported
Every route from the old backend is now converted and wired into
`src/index.ts`: `auth`, `dashboard`, `companies`, `track`, `users`,
`tempLinks`, `yarns`, `copColors`. `npx tsc --noEmit` and
`wrangler deploy --dry-run` both pass clean.

**No standalone `machines.ts`** — the original backend has no separate
"machines" table/resource. The machine-matrix endpoints
(`PUT /track/:uid/machine`, `DELETE /track/:uid/machine/:rowId`) are a
sub-resource of a track batch and live inside `track.ts`, same as in the
old codebase. If your product actually needs a standalone machines
catalog (e.g. a list of physical TFO machines, distinct from the
per-batch machine log), that's new functionality, not a port — let me
know and I'll design the table + routes from scratch.

`validators.ts` — Zod schemas are byte-for-byte identical to the old
backend. Only `validateBody`/`validateParams` changed shape: Express
wrote the 400 response itself and returned `null`; the Hono versions
return either the parsed data or a `Response` object, checked with
`isValidationResponse()`:
```ts
const raw = await c.req.json();
const parsed = validateBody(c, raw, mySchema);
if (isValidationResponse(parsed)) return parsed; // 400 already sent
// parsed is now the typed, validated body
```

Two small non-mechanical swaps worth knowing about if you touch these
files again:
- `tempLinks.ts` — `uuid`'s `v4()` replaced with Workers-native
  `crypto.randomUUID()`; `req.socket.remoteAddress` replaced with the
  `CF-Connecting-IP` header (no raw socket access on Workers).
- `tempLinks.ts` validate route — the old fire-and-forget
  `void Promise.all([...])` for logging/incrementing use_count is now
  wrapped in `c.executionCtx.waitUntil(...)`. Workers can terminate
  in-flight work once a response is returned, so a bare un-awaited
  promise isn't guaranteed to finish — `waitUntil` is the correct
  primitive for "don't block the response, but do let this complete."

## Deploy
```bash
npm install
npx wrangler login

# Create the KV-backed rate limit namespaces referenced in wrangler.toml
# (or remove the [[unsafe.bindings]] blocks and the rate limit calls if
# you're on a plan/tier where the binding isn't available — the Rate
# Limiting binding currently requires a paid Workers plan)

wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SESSION_SECRET      # must match your old backend's value
                                          # if you want existing sessions to keep working
wrangler secret put FRONTEND_URL
wrangler secret put BACKEND_URL
wrangler secret put ADMIN_EMAIL

npm run deploy
```

Update your Supabase Auth redirect URL and your frontend's `BACKEND_URL`
to point at the new `*.workers.dev` (or custom) domain.

## Known limitations / things to verify before cutover
- **Durable Object billing**: `RealtimeRoom` holds a permanent outbound
  connection to Supabase Realtime, so it never hibernates — it's billed
  as continuously active. For a single internal room this is cheap, but
  it's a real cost, not zero like idle Workers requests.
- **Rate Limiting binding** availability depends on your Cloudflare plan —
  check the dashboard before deploying; if unavailable, swap it for a
  Durable Object counter (happy to write that if needed).
- Test the OAuth PKCE flow end-to-end — the crypto swap (Node `crypto` →
  Web Crypto) produces the same values but wasn't run against your live
  Google OAuth app in this pass.
