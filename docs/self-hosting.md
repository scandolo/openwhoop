# Self-hosting

OpenWhoop is one Node process with an SQLite file, so anything that runs a
container with a persistent disk can host it.

**Web Bluetooth needs a secure page.** The browser that talks to your strap
must load OpenWhoop over `https://`, or from `http://localhost`. A hosted
instance therefore needs TLS. Every option below provides it, or shows how.

## Password and first run

On localhost with no password, OpenWhoop is open. Anyone who can reach your
machine's loopback can use it, which in practice means only you. Set a password
in **Settings → Access** to lock it.

When it listens on the network (`HOST=0.0.0.0`, which the Docker image does),
a password is required. Either:
- set `OPENWHOOP_PASSWORD`, or
- start it and open the one-time setup link printed in the log:
  `First run: create your password at https://…/setup?token=…`

Sessions last 30 days. Changing the password signs out every other session.
Login is rate-limited to 10 attempts per IP per 15 minutes.

## Docker

```bash
docker compose up -d          # http://localhost:8787, data in the openwhoop-data volume
docker compose logs openwhoop # shows the setup link on first run
```

Or without compose:

```bash
docker build -t openwhoop .
docker run -d -p 8787:8787 -v openwhoop-data:/data -e OPENWHOOP_PASSWORD='choose-one' openwhoop
```

## Railway

1. New project → Deploy from GitHub repo. The Dockerfile is picked up.
2. Add a **Volume** mounted at `/data`.
3. Variables: `OPENWHOOP_PASSWORD`, and `PUBLIC_URL` (your `https://…up.railway.app`
   or custom domain).
4. Generate a domain. Railway terminates TLS.

## Fly.io

```bash
fly launch --no-deploy            # accept the Dockerfile, internal port 8787
fly volumes create openwhoop_data --size 3
# in fly.toml:  [mounts] source = "openwhoop_data"  destination = "/data"
fly secrets set OPENWHOOP_PASSWORD='choose-one' PUBLIC_URL='https://<app>.fly.dev'
fly deploy
```

## A VPS with Caddy

```bash
docker run -d --name openwhoop -p 127.0.0.1:8787:8787 -v openwhoop-data:/data \
  -e OPENWHOOP_PASSWORD='choose-one' -e PUBLIC_URL='https://whoop.example.com' openwhoop
```

```
# /etc/caddy/Caddyfile
whoop.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

## Configuration

| Variable | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `PORT` | `8787` | |
| `OPENWHOOP_DATA_DIR` | `./data` (`/data` in Docker) | SQLite database lives here |
| `OPENWHOOP_PASSWORD` | — | Owner password from the environment |
| `OPENWHOOP_AUTH` | `auto` | `on`: password even on localhost. `off`: never ask (trusted networks only) |
| `PUBLIC_URL` | — | External `https://` URL, used for OAuth callbacks behind a proxy |
| `RAW_RETENTION_DAYS` | `30` | How long raw strap frames are kept for re-decoding (`0` keeps them forever) |

## Storage and backups

Expect about 5.5 MB per day of wear for the per-second samples, plus about
3 MB per day of compressed raw frames kept for `RAW_RETENTION_DAYS` (30 days ≈
90 MB). A year of wear comes to roughly 2 GB. Back up by copying `openwhoop.db` while the
server is stopped, or use `sqlite3 openwhoop.db ".backup backup.db"` while it
runs.
