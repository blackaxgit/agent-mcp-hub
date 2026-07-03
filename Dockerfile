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
# cursor-agent ships only via the vendor's install script (no checksums
# published, so it cannot be integrity-pinned). Opt out of the curl|bash
# supply-chain risk with: docker build --build-arg INSTALL_CURSOR=false .
# When enabled, an installer failure fails the build (no silent masking).
ARG INSTALL_CURSOR=true
RUN if [ "$INSTALL_CURSOR" = "true" ]; then curl -fsS https://cursor.com/install | bash; fi
ENV PATH="/home/mcp/.local/bin:${PATH}"

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json ./

ENV PORT=3919
# Inside the container the server must bind all interfaces so the published
# port works; host exposure is restricted in docker-compose.yml (127.0.0.1).
ENV HOST=0.0.0.0
EXPOSE 3919
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -fsS http://localhost:3919/healthz || exit 1
CMD ["node", "dist/http.js"]
