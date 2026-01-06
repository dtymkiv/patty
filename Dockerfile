# --- Stage 1: Frontend Build ---
FROM node:18-slim AS frontend-builder
WORKDIR /app

# Install dependencies
COPY package.json .
RUN npm install

# Copy source configuration and static files
COPY input.css .
COPY tailwind.config.js .
COPY static ./static

# Build CSS
RUN npm run build:css

# Transform index.html for production
# 1. Switch Vue to production build
# 2. Replace Tailwind CDN with local CSS
# 3. Remove inline Tailwind config
RUN sed -i 's/vue.global.js/vue.global.prod.js/g' static/index.html && \
    sed -i 's|<script src="https://cdn.tailwindcss.com"></script>|<link rel="stylesheet" href="/static/styles.css">|' static/index.html && \
    sed -i '/tailwind.config = {/,/}/d' static/index.html

# --- Stage 2: Backend Build ---
FROM python:3.11-slim AS backend-builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies into a separate directory
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# --- Stage 3: Final ---
FROM python:3.11-slim

WORKDIR /app

# Copy installed dependencies from backend-builder
COPY --from=backend-builder /install /usr/local

# Copy source code (this copies local static/ too)
COPY . .

# Overwrite static/ with the built version from frontend-builder
COPY --from=frontend-builder /app/static /app/static

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Expose the port (Railway will use the $PORT env var)
EXPOSE 8000

# Command to run the application
# Using a single worker is CRITICAL because the application stores state in-memory (manager.py).
# Multi-worker setups would require Redis/database for state sharing.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1 --loop uvloop --ws websockets --timeout-keep-alive 60"]
