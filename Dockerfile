# ==============================================================================
# Multi-Stage Production Dockerfile for Yimly Home Assistant
# Stage 1: Build Frontend (Vite + React + TypeScript + Tailwind CSS)
# Stage 2: Production Runtime (Python 3.11 FastAPI Backend + HA Core Compatibility)
# ==============================================================================

# Stage 1: Frontend Build
FROM node:20-alpine AS frontend-builder
WORKDIR /app

# Copy dependency manifests and install dependencies
COPY package.json ./
RUN npm install

# Copy configuration and frontend source code
COPY tsconfig.json vite.config.ts index.html server.ts ./
COPY public ./public
COPY src ./src

# Build static production bundle into /app/dist
RUN npm run build

# Stage 2: Production Backend Runtime
FROM python:3.11-slim AS production
WORKDIR /app

# Install system dependencies (curl for healthchecks, build-essential for any compiled modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application code
COPY app ./app
COPY tests ./tests
COPY metadata.json .

# Copy compiled frontend from Stage 1 into /app/dist
COPY --from=frontend-builder /app/dist ./dist

# Create persistent storage directories
RUN mkdir -p /data/uploads/profile_pictures /app/uploads/profile_pictures

# Environment defaults for production container
ENV APP_ENV=production \
    DATA_DIR=/data \
    DATABASE_URL=sqlite+aiosqlite:////data/ha_server.db \
    UPLOADS_DIR=/data/uploads \
    PORT=3000 \
    PYTHONUNBUFFERED=1

EXPOSE 3000

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/config || exit 1

# Start production server
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3000", "--proxy-headers", "--forwarded-allow-ips", "*", "--ws-ping-interval", "15", "--ws-ping-timeout", "30"]
