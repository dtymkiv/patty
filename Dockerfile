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

# --- Stage 2: Backend Build (Go) ---
FROM golang:1.25-alpine AS backend-builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the Go application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o server_bin .

# --- Stage 3: Final ---
FROM alpine:latest

WORKDIR /app

# Install runtime dependencies (ca-certificates for HTTPS if needed)
RUN apk --no-cache add ca-certificates

# Copy the Go binary from builder (do this first)
COPY --from=backend-builder /build/server_bin .

# Copy static files from frontend builder
COPY --from=frontend-builder /app/static ./static

# Set environment variables
ENV PORT=8000
ENV ADDR=:8000

# Expose the port (Railway will use the $PORT env var)
EXPOSE 8000

# Command to run the application
CMD ["./server_bin", "-addr", ":8000"]
