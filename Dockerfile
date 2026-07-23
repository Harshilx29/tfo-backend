# ── Stage 1: Build TypeScript source code ──────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency specifications
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies required for tsc)
RUN npm ci

# Copy application source code
COPY src ./src

# Build TypeScript to compiled JavaScript (dist/)
RUN npm run build

# ── Stage 2: Production runner ─────────────────────────────
FROM node:20-alpine AS runner

# Set NODE_ENV to production
ENV NODE_ENV=production

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies (clean & small footprint)
RUN npm ci --only=production && npm cache clean --force

# Copy compiled JavaScript output from builder stage
COPY --from=builder /app/dist ./dist

# Expose default port (Back4App overrides PORT dynamically at runtime)
EXPOSE 3001

# Run compiled production server
CMD ["node", "dist/index.js"]
