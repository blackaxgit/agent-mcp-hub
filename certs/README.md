# certs/

Drop the root CA of any TLS-intercepting proxy (Cloudflare WARP/Gateway, Zscaler, …)
here, as **PEM** with a **`.crt`** extension. Certificates are gitignored — only this
README and `.gitkeep` are tracked, because the CA is environment-specific.

The CA is consumed in **two independent places**. You may need one, both, or neither.

## 1. Build time — so the image can be built behind the proxy

The Dockerfile copies this directory into `/usr/local/share/ca-certificates/extra/` and
runs `update-ca-certificates`, trusting it image-wide **before** `npm install -g` and
before `cursor-agent` is downloaded from `downloads.cursor.com`.

Without it, the build dies at:

```
curl: (60) SSL certificate problem: self-signed certificate in certificate chain
```

`curl` reads the **system** trust store and ignores `NODE_EXTRA_CA_CERTS` — exporting
that variable on the host fixes node and npm but never fixes `curl`. The system store
is the load-bearing half.

```bash
cp ~/cert/Cloudflare_CA.crt certs/
docker compose build
```

You can skip this entirely by pulling the published image instead of building it, or by
opting out of cursor: `docker compose build --build-arg INSTALL_CURSOR=false`.

## 2. Run time — so ONE image works on every network

This directory is also mounted read-only at `/etc/agent-hub/certs`. Point the agents at
the CA with two variables in `.env`, and the *same* image works both behind the proxy
and off it — no rebuild per environment:

```bash
NODE_EXTRA_CA_CERTS=/etc/agent-hub/certs/proxy-ca.crt   # node CLIs: cursor-agent, claude
SSL_CERT_FILE=/etc/agent-hub/certs/proxy-ca.crt         # native CLIs: codex
```

Both default to empty when unset, and both runtimes ignore an empty value — which is the
correct behaviour on a clean network. Two variables are needed because the wrapped CLIs
do not share a TLS stack: the node-based ones honour `NODE_EXTRA_CA_CERTS`, while a
natively-compiled binary does not.

## Why the CA is not committed

It identifies your corporate egress proxy and differs per environment. `.gitignore`
tracks only `README.md` and `.gitkeep` here, so the Dockerfile's `COPY certs/` always
resolves while the certificate itself never ships in the repo or in a published image
layer built from a clean checkout.
