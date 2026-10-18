# Deployment

## Current state

The repo ships a `Dockerfile` and a `docker run` example in the README,
meant to sit behind an existing nginx doing `proxy_pass` to
`http://127.0.0.1:3000/gitea-webhook`.

## Project deployment standard

This project's standard deployment target for a web service is an LXC
container or a VPS running Debian/Ubuntu, with the service managed by
systemd (not Docker) and updated through an idempotent script triggered by
an authenticated HTTP endpoint. As of this bootstrap, none of the following
exist yet in this repo:

- [ ] A systemd unit file for the service.
- [ ] An idempotent `scripts/update.sh` (pull, install deps, restart,
      fail-safe, logged).
- [ ] An authenticated endpoint that triggers the update script (token-based
      auth, async run, single-flight, rate-limited, status endpoint).
- [ ] The corresponding `UPDATE_TOKEN`-style variable in `.env.example`.

Setting these up is a separate task from this bootstrap; this file tracks
what's missing so it isn't lost.

## Environment variables

See `../.env.example` and the table in `../README.md`.
