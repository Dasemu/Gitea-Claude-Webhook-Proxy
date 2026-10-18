# CLAUDE.md

## Overview
Node.js/Express proxy that receives Gitea webhooks and forwards them to the
Claude Code Routines API, adding headers Gitea can't send itself. See
`README.md` for the request flow and `docs/` for deployment details.

## Commands
- Dev: `npm install && cp .env.example .env` (fill in real values), then `node server.js`
- Test: none configured yet
- Lint: none configured yet
- Build: none (plain Node.js, no build step)
- Syntax check: `node --check server.js`

## Architecture
Single-file Express server (`server.js`) exposing `POST /gitea-webhook` and
`GET /health`. No database, no persistent state beyond an in-memory dedup
cache. See `docs/` for deployment (currently Docker-only; see Gotchas).

## Conventions
- CommonJS (`require`/`module.exports`), no TypeScript, no build step.
- Keep the whole proxy in `server.js` unless it grows enough to justify splitting.

## Workflow quirks
- No test suite or linter exists yet; CI only runs the syntax check.

## Deployment
- Current: Docker image built from the repo `Dockerfile`, meant to run behind
  an existing nginx reverse proxy doing `proxy_pass` to `127.0.0.1:3000`.
- The project's deployment standard (see `docs/deployment.md`) expects a
  systemd unit, an idempotent `scripts/update.sh`, and an authenticated
  update-trigger endpoint. None of these exist yet in this repo.

## Gotchas
- Gitea's `X-Gitea-Event-Type` sub-event is needed to detect `issue_assign` /
  `pull_request_assign`; the coarse `X-Gitea-Event` header isn't enough (see
  README's "Known limitation" note on assignee diffing).
- `.env` is never committed; `.env.example` lists variable names only.
