# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs available on PATH for the server to spawn
RUN npm install -g @openai/codex opencode-ai

RUN useradd -m -u 1001 mcp
USER mcp
# Best-effort: cursor-agent installs to ~/.local/bin; if the installer is
# unavailable at build time the cursor tool simply reports unavailable.
RUN curl -fsS https://cursor.com/install | bash \
 || echo "WARN: cursor-agent install failed; the cursor tool will be unavailable"
ENV PATH="/home/mcp/.local/bin:${PATH}"

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json ./

ENV PORT=3919
EXPOSE 3919
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -fsS http://localhost:3919/healthz || exit 1
CMD ["node", "dist/http.js"]
