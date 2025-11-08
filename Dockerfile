# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src

# Expose port
EXPOSE 8080

# Set environment to production
ENV NODE_ENV=production

# Run TypeScript source directly
CMD ["bun", "src/server.ts"]