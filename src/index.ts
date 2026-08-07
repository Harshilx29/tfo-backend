import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { Env } from './lib/supabase';
import { apiLimiter } from './middleware/rateLimit';
import { AuthedContext } from './middleware/auth';

import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import companiesRoutes from './routes/companies';
import trackRoutes from './routes/track';
import usersRoutes from './routes/users';
import tempLinksRoutes from './routes/tempLinks';
import yarnsRoutes from './routes/yarns';
import copColorsRoutes from './routes/copColors';
import machinesRoutes from './routes/machines';

export { RealtimeRoom } from './do/RealtimeRoom';

type Vars = { userId?: string; profile?: any; tempAccess?: any };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── CORS — same allow-list logic as the old rawFrontendUrls handling ──
app.use('*', (c, next) => {
  const raw = c.env.FRONTEND_URL || 'http://localhost:5173';
  const allowed = raw.split(',').map((u) => u.trim()).filter(Boolean);
  return cors({
    origin: (origin) => {
      if (!origin) return allowed[0];
      // Always allow localhost/127.0.0.1 for local dev
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return origin;
      }
      // Allow any Vercel domain associated with the project
      if (origin.endsWith('.vercel.app') || origin.includes('.vercel.app')) {
        return origin;
      }
      // Allow exact match from FRONTEND_URL configured values
      if (allowed.includes(origin)) {
        return origin;
      }
      return allowed[0];
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Cache-Control'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })(c, next);
});

// ── Security headers — replaces helmet ──
app.use(
  '*',
  secureHeaders({
    crossOriginResourcePolicy: 'cross-origin',
    // API-only, JSON responses — omit CSP entirely rather than passing `false`.
  })
);

// ── Health check (exempt from rate limiting, same as before) ──
app.get('/health', (c) => c.json({ status: 'ok' }));

// ── Global rate limiter for everything else ──
app.use('*', async (c, next) => {
  if (c.req.path === '/health') return next();
  return apiLimiter(c as AuthedContext, next);
});

// ── WebSocket upgrade — replaces the socket.io endpoint ──
// One shared room instance (idFromName('global')) mirrors the old
// single-process socket.io server; every client connects here and gets
// filtered into rooms server-side, same as before.
app.get('/realtime', async (c) => {
  const id = c.env.REALTIME_ROOM.idFromName('global');
  const stub = c.env.REALTIME_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

// ── Routes ──────────────────────────────────────────────
app.route('/auth', authRoutes);
app.route('/dashboard', dashboardRoutes);
app.route('/companies', companiesRoutes);
app.route('/track', trackRoutes);
app.route('/users', usersRoutes);
app.route('/temp-links', tempLinksRoutes);
app.route('/yarns', yarnsRoutes);
app.route('/cop-colors', copColorsRoutes);
app.route('/machines', machinesRoutes);

// ── 404 ──
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ── Error handler ──
app.onError((err, c) => {
  console.error(err);
  const isProd = c.env && (c as any).env?.NODE_ENV === 'production';
  return c.json({ error: isProd ? 'Internal server error' : err.message || 'Internal server error' }, 500);
});

export default app;
