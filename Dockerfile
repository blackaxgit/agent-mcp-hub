# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script (npm run build) would fire here, before
# tsconfig.json/src are copied. The explicit npm run build below compiles.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/*

# TLS-intercepting corporate proxies (e.g. Cloudflare Gateway) inject a self-signed
# root into every chain, which breaks `npm install -g` and the cursor installer's
# `curl https://cursor.com/install` with "self-signed certificate in certificate
# chain". Drop the proxy's root CA into certs/ as a PEM file with a .crt extension
# and it is trusted image-wide, by curl (system store) AND node (NODE_EXTRA_CA_CERTS
# — curl does NOT read that variable, so the system store is the load-bearing half).
# certs/ ships with only .gitkeep, so builds without a proxy are unaffected.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Agent CLIs available on PATH for the server to spawn
# @anthropic-ai/claude-code ships a native binary and needs Node 22+ (satisfied here).
# Pinned for reproducible builds. Dependabot's docker ecosystem does not track npm -g
# installs — bump these manually (or move to a tracked manifest) when updating agents.
RUN npm install -g @openai/codex@0.142.5 opencode-ai@1.17.13 @anthropic-ai/claude-code@2.1.199

# cursor-agent, installed from a PINNED, checksum-verified release tarball rather
# than the vendor's `curl https://cursor.com/install | bash`. That installer verifies
# no checksums and pipes curl straight into tar, so a truncated or substituted
# download can partially extract. Here it is download -> verify sha256 -> extract, so
# a corrupted or swapped artifact aborts the build. This is the same integrity-pinned
# pattern used for other vendor binaries in CI.
#
# Bump CURSOR_VERSION and BOTH hashes together. Obtain them with:
#   curl -fsSL https://downloads.cursor.com/lab/<version>/linux/<arm64|x64>/agent-cli-package.tar.gz | sha256sum
#
# Opt out entirely with: docker build --build-arg INSTALL_CURSOR=false .
ARG INSTALL_CURSOR=true
ARG CURSOR_VERSION=2026.07.09-a3815c0
ARG CURSOR_SHA256_ARM64=11b2b6801136a11a3632a4b1080ea3bfc7d97d0a68382be9ede1faf5333207fb
ARG CURSOR_SHA256_X64=c7c1f32249cedb99cc20cd4eed1f9308dc2299a78c283bbc6efd6d658cd4977e
ARG TARGETARCH
RUN set -eu; \
    if [ "$INSTALL_CURSOR" != "true" ]; then \
      echo "INSTALL_CURSOR=false — skipping cursor-agent"; exit 0; \
    fi; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      arm64) carch=arm64; sha="$CURSOR_SHA256_ARM64" ;; \
      amd64) carch=x64;   sha="$CURSOR_SHA256_X64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${carch}/agent-cli-package.tar.gz"; \
    tmp="$(mktemp -d)"; \
    curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/cursor.tgz" "$url"; \
    echo "${sha}  $tmp/cursor.tgz" | sha256sum -c -; \
    mkdir -p /opt/cursor-agent; \
    tar --strip-components=1 -xzf "$tmp/cursor.tgz" -C /opt/cursor-agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent; \
    ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/agent; \
    rm -rf "$tmp"

RUN useradd -m -u 1001 mcp
USER mcp
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
