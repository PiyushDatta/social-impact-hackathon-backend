# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN bun run build

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install only production dependencies
RUN bun install --frozen-lockfile --production

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 8080

# Set environment to production
ENV NODE_ENV=production

# Health check (optional but recommended)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun run -e "fetch('http://localhost:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

# Start the application
CMD ["bun", "run", "dist/server.js"]