# Gitea-Claude-Webhook-Proxy

Proxy en Node.js/Express que recibe webhooks de Gitea y los reenvía a la API
de Claude Code Routines, añadiendo los headers que Gitea no permite
configurar (`Authorization: Bearer <token>`, `anthropic-beta`,
`anthropic-version`).

## Cómo funciona

1. Gitea hace `POST` a `/gitea-webhook` con:
   - Header `Authorization: <secreto-A>` (configurado a mano en Gitea).
   - Header `X-Gitea-Signature`: HMAC-SHA256 del body crudo con el `Secret`
     del webhook.
2. El proxy valida ambos (comparación constant-time) y responde 401 si no
   coinciden.
3. Deduplica por `X-Gitea-Delivery` (TTL configurable) para no reenviar
   reintentos de Gitea.
4. Construye un `text` legible a partir del payload (`push`, `pull_request`;
   cualquier otro evento cae en un mensaje genérico) y responde `200` a
   Gitea de inmediato.
5. En segundo plano, hace `POST` a
   `https://api.anthropic.com/v1/claude_code/routines/{ROUTINE_ID}/fire`
   con el `text` y loguea el resultado (éxito, 401/429/5xx, o fallo de red)
   sin tumbar el proceso.

## Variables de entorno

Ver [.env.example](.env.example). Copia el archivo y rellena los valores
reales (no se suben al repo, `.env` está en `.gitignore`):

```bash
cp .env.example .env
```

| Variable | Descripción |
| --- | --- |
| `PORT` | Puerto donde escucha el proxy (por defecto `3000`). |
| `GITEA_AUTH_HEADER` | Valor esperado del header `Authorization` que envía Gitea. |
| `GITEA_WEBHOOK_SECRET` | Secret del webhook en Gitea, usado para verificar `X-Gitea-Signature`. |
| `ROUTINE_ID` | ID de la rutina de Claude Code (`trig_...`). |
| `ROUTINE_TOKEN` | Token de la rutina (`sk-ant-oat01-...`), se envía como `Bearer`. |
| `DEDUP_TTL_MS` | TTL en ms para el dedup en memoria de entregas (por defecto 300000 = 5 min). |

## Ejecutar en local

```bash
npm install
cp .env.example .env   # y rellena los valores reales
node server.js
```

Endpoint de salud: `GET /health` → `{"status":"ok"}`.

## Configurar el webhook en Gitea

En el repo/organización → Settings → Webhooks → Add webhook:

- URL: `https://tu-dominio/gitea-webhook`
- Content type: `application/json`
- Secret: el mismo valor que `GITEA_WEBHOOK_SECRET`
- Authorization header: el mismo valor que `GITEA_AUTH_HEADER`
- Eventos: `Push` y/o `Pull Request` (los demás eventos se reenvían con un
  mensaje genérico)

## Docker

```bash
docker build -t gitea-claude-webhook-proxy .
docker run -d --name gitea-claude-webhook-proxy \
  --env-file .env \
  -p 3000:3000 \
  gitea-claude-webhook-proxy
```

Pensado para ir detrás de un nginx existente haciendo `proxy_pass` hacia
`http://127.0.0.1:3000/gitea-webhook`.
