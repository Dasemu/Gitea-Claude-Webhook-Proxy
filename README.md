# Gitea-Claude-Webhook-Proxy

Node.js/Express proxy that receives Gitea webhooks and forwards them to the
Claude Code Routines API, adding the headers Gitea can't be configured to
send itself (`Authorization: Bearer <token>`, `anthropic-beta`,
`anthropic-version`).

## How it works

1. Gitea sends a `POST` to `/gitea-webhook` with:
   - Header `Authorization: <secret-A>` (configured by hand in Gitea).
   - Header `X-Gitea-Signature`: HMAC-SHA256 of the raw body using the
     webhook's `Secret`.
2. The proxy validates both (constant-time comparison) and returns 401 if
   either one doesn't match.
3. It deduplicates by `X-Gitea-Delivery` (configurable TTL) to avoid
   reprocessing Gitea retries.
4. It builds a readable `text` from the payload (`push`, `pull_request`;
   any other event falls back to a generic message) and responds `200` to
   Gitea immediately.
5. In the background, it makes a `POST` to
   `https://api.anthropic.com/v1/claude_code/routines/{ROUTINE_ID}/fire`
   with that `text` and logs the outcome (success, 401/429/5xx, or a
   network failure) without crashing the process.

### Issue/PR assignment to Claude

Gitea's coarse `X-Gitea-Event` header (`issues`, `pull_request`) doesn't say
*what changed* — the precise sub-event is in `X-Gitea-Event-Type`. The proxy
reads that header to detect `issue_assign` and `pull_request_assign`
deliveries and only forwards them when the assignees list actually includes
`CLAUDE_GITEA_USERNAME`; any other assignment change gets a `200 {"status":
"ignored"}` without hitting the routine.

**Known limitation:** Gitea (tested on 1.25.4) doesn't tell you *who* was
just added to `assignees`, only the full current list. If Claude was already
assigned and someone else gets added too, this still counts as "assigned to
Claude" and fires again — telling the two apart would require comparing
against the previous assignees, which Gitea doesn't send.

## Environment variables

See [.env.example](.env.example). Copy it and fill in the real values
(never committed — `.env` is in `.gitignore`):

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `PORT` | Port the proxy listens on (defaults to `3000`). |
| `GITEA_AUTH_HEADER` | Expected value of the `Authorization` header Gitea sends. |
| `GITEA_WEBHOOK_SECRET` | Gitea webhook secret, used to verify `X-Gitea-Signature`. |
| `ROUTINE_ID` | Claude Code routine ID (`trig_...`). |
| `ROUTINE_TOKEN` | Routine token (`sk-ant-oat01-...`), sent as `Bearer`. |
| `DEDUP_TTL_MS` | TTL in ms for the in-memory delivery dedup (defaults to 300000 = 5 min). |
| `FIRE_TIMEOUT_MS` | Timeout in ms for the call to Anthropic's API (defaults to 10000). |
| `CLAUDE_GITEA_USERNAME` | Gitea username to match on issue/PR assignment events (defaults to `claude`). |

## Running locally

```bash
npm install
cp .env.example .env   # then fill in the real values
node server.js
```

Health check endpoint: `GET /health` → `{"status":"ok"}`.

## Configuring the webhook in Gitea

On the repo/organization → Settings → Webhooks → Add webhook:

- URL: `https://your-domain/gitea-webhook`
- Content type: `application/json`
- Secret: same value as `GITEA_WEBHOOK_SECRET`
- Authorization header: same value as `GITEA_AUTH_HEADER`
- Events: `Push`, `Issues` (at least "Assigned"), and/or `Pull Request` (at
  least "Assigned") — any other event is forwarded with a generic message

## Docker

```bash
docker build -t gitea-claude-webhook-proxy .
docker run -d --name gitea-claude-webhook-proxy \
  --env-file .env \
  -p 3000:3000 \
  gitea-claude-webhook-proxy
```

Meant to sit behind an existing nginx doing `proxy_pass` to
`http://127.0.0.1:3000/gitea-webhook`.
