import rateLimit from 'express-rate-limit';

/**
 * Global API rate limiter.
 * Applies to ALL routes — 100 requests per minute per IP.
 * Prevents brute-force, DDoS, and scraping.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 100,                   // limit each IP to 100 requests per window
  standardHeaders: true,      // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,       // Disable the X-RateLimit-* headers
  message: { error: 'Too many requests — please slow down and try again.' },
  skip: (req) => {
    // Skip health-check endpoint from rate limiting
    return req.path === '/health';
  },
});

/**
 * Strict auth limiter — applies to OAuth login endpoints only.
 * 10 attempts per minute per IP to prevent login abuse.
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute window
  max: 10,                    // Only 10 login attempts per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please wait a minute and try again.' },
});

/**
 * Strict temp-link validation limiter.
 * Prevents token enumeration/brute-force attacks on public validate endpoint.
 * 20 attempts per 5 minutes per IP.
 */
export const tempLinkLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,   // 5 minute window
  max: 20,                    // 20 validation attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many link validation attempts — please wait and try again.' },
});
