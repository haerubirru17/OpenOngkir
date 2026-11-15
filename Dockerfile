# OpenOngkir — satu service Node + SQLite, tanpa framework.
# Butuh Node >= 24 (node:sqlite).
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src/ ./src/
COPY --chown=node:node db/ ./db/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node scripts/ ./scripts/

# Direktori data (DB SQLite) — di-mount sebagai volume agar persisten.
RUN mkdir -p data && chown node:node data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
