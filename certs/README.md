# certs/

Drop the root CA of any TLS-intercepting proxy here, as **PEM** with a **`.crt`**
extension. The Dockerfile copies this directory into
`/usr/local/share/ca-certificates/extra/` and runs `update-ca-certificates`, so the
cert is trusted image-wide before `npm install -g` and the cursor installer run.

Without this, behind a corporate proxy the build fails at:

```
curl -fsS -o /tmp/cursor-install.sh https://cursor.com/install
# curl: (60) SSL certificate problem: self-signed certificate in certificate chain
```

`curl` reads the **system** trust store, not `NODE_EXTRA_CA_CERTS` — exporting that
variable on the host fixes node/npm but never fixes `curl`. Both are wired up in the
Dockerfile.

## Usage

```bash
cp ~/cert/Cloudflare_CA.crt certs/
docker compose build
docker compose up -d
```

Certificates are gitignored (only this README and `.gitkeep` are tracked) — the CA is
environment-specific and should not ship in the repo. If you have no intercepting
proxy, leave the directory as-is; `update-ca-certificates` is a no-op.

Opt out of the cursor install entirely instead:
`docker compose build --build-arg INSTALL_CURSOR=false`
