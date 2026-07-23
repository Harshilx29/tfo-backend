import dotenv from 'dotenv';
dotenv.config();

// Global safety handlers to prevent crashes from network/DNS transient issues
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import trackRoutes from './routes/track';
import usersRoutes from './routes/users';
import tempLinksRoutes from './routes/tempLinks';
import companiesRoutes from './routes/companies';
import yarnsRoutes from './routes/yarns';
import copColorsRoutes from './routes/copColors';
import { initRealtime } from './ws/realtime';
import { apiLimiter } from './middleware/rateLimit';

const app    = express();
// Trust proxy settings (required for rate limiting behind reverse proxies like Back4App / Cloudflare)
app.set('trust proxy', 1);
const server = createServer(app);
const PORT   = process.env.PORT || 3001;

// Support single URL or comma-separated list of allowed frontend origins
const rawFrontendUrls = process.env.FRONTEND_URL || 'http://localhost:5173';
const allowedOrigins  = rawFrontendUrls.includes(',')
  ? rawFrontendUrls.split(',').map((u) => u.trim()).filter(Boolean)
  : rawFrontendUrls.trim();

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// ── Socket.IO server ────────────────────────────────────
export const io = new SocketIOServer(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

// ── Security middleware ─────────────────────────────────
// helmet sets safe HTTP headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow cross-origin API calls
  contentSecurityPolicy: false, // API-only server; CSP not needed for JSON responses
}));

// Global rate limiter — 100 req/min per IP across all endpoints
app.use(apiLimiter);

// ── Express middleware ──────────────────────────────────
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(SESSION_SECRET));

// ── Health check ────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Routes ──────────────────────────────────────────────
app.use('/auth',       authRoutes);
app.use('/dashboard',  dashboardRoutes);
app.use('/track',      trackRoutes);
app.use('/users',      usersRoutes);
app.use('/temp-links', tempLinksRoutes);
app.use('/companies',  companiesRoutes);
app.use('/yarns',      yarnsRoutes);
app.use('/cop-colors', copColorsRoutes);

// ── 404 catch-all ───────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ───────────────────────────────────────
// In production: never expose raw error messages (information leakage risk).
// In development: full message shown for debugging.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      error: isProd ? 'Internal server error' : (err.message || 'Internal server error'),
    });
  }
);

// ── Realtime WebSocket bridge ────────────────────────────
initRealtime(io);

// ── Start ────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n✅  Track Manager API   → Port ${PORT}`);
  console.log(`   WebSocket (socket.io) → Port ${PORT}`);
  console.log(`   CORS origins          → ${rawFrontendUrls}\n`);
});
