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
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs available on PATH for the server to spawn
# @anthropic-ai/claude-code ships a native binary and needs Node 22+ (satisfied here).
# Pinned for reproducible builds. Dependabot's docker ecosystem does not track npm -g
# installs — bump these manually (or move to a tracked manifest) when updating agents.
RUN npm install -g @openai/codex@0.142.5 opencode-ai@1.17.13 @anthropic-ai/claude-code@2.1.199

RUN useradd -m -u 1001 mcp
USER mcp
# cursor-agent ships only via the vendor's install script (no checksums
# published, so it cannot be integrity-pinned). Opt out of the curl|bash-style
# supply-chain risk with: docker build --build-arg INSTALL_CURSOR=false .
# Download-then-execute (not curl|bash): POSIX sh has no pipefail, so a piped
# curl failure would feed bash an empty script and exit 0 — this form makes a
# failed download or install abort the build. Known cause: TLS-intercepting
# corporate proxies ("self-signed certificate in certificate chain") — build
# with --build-arg INSTALL_CURSOR=false or provide the proxy CA certificate.
ARG INSTALL_CURSOR=true
RUN if [ "$INSTALL_CURSOR" = "true" ]; then curl -fsS -o /tmp/cursor-install.sh https://cursor.com/install && bash /tmp/cursor-install.sh && rm /tmp/cursor-install.sh; fi
ENV PATH="/home/mcp/.local/bin:${PATH}"

WORKDIR /app
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json ./

ENV PORT=3919
EXPOSE 3919
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD curl -fsS "http://localhost:${PORT:-3919}/healthz" || exit 1
# tini as PID 1 reaps zombie agent grandchildren and forwards signals.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/http.js"]
