'use strict';

const crypto = require('crypto');
const express = require('express');

const {
  PORT = '3000',
  GITEA_AUTH_HEADER,
  GITEA_WEBHOOK_SECRET,
  ROUTINE_ID,
  ROUTINE_TOKEN,
  DEDUP_TTL_MS = String(5 * 60 * 1000),
  FIRE_TIMEOUT_MS = String(10 * 1000),
} = process.env;

for (const [name, value] of Object.entries({
  GITEA_AUTH_HEADER,
  GITEA_WEBHOOK_SECRET,
  ROUTINE_ID,
  ROUTINE_TOKEN,
})) {
  if (!value) {
    console.error(JSON.stringify({ level: 'error', message: `Missing environment variable ${name}` }));
    process.exit(1);
  }
}

const ANTHROPIC_FIRE_URL = `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE_ID}/fire`;
const ANTHROPIC_BETA_HEADER = 'experimental-cc-routine-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TEXT_LENGTH = 65536;
const dedupTtlMs = Number(DEDUP_TTL_MS);
const fireTimeoutMs = Number(FIRE_TIMEOUT_MS);

const app = express();
app.disable('x-powered-by');

function log(level, fields) {
  const line = { level, timestamp: new Date().toISOString(), ...fields };
  // Everything goes to stdout on purpose: a single tail/log driver then sees
  // info and error together, instead of relying on something downstream to
  // split stdout/stderr back apart.
  console.log(JSON.stringify(line));
}

// Constant-time string comparison. Returns false (without leaking length
// via early exit timing) when the inputs differ in length.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyGiteaSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', GITEA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return safeCompare(expected.toLowerCase(), String(signatureHeader).toLowerCase());
}

// Dedup of Gitea deliveries (by X-Gitea-Delivery) with an in-memory TTL.
const seenDeliveries = new Map();

function isDuplicateDelivery(deliveryId) {
  if (!deliveryId) return false;
  const now = Date.now();
  const seenAt = seenDeliveries.get(deliveryId);
  if (seenAt && now - seenAt < dedupTtlMs) {
    return true;
  }
  seenDeliveries.set(deliveryId, now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, seenAt] of seenDeliveries) {
    if (now - seenAt >= dedupTtlMs) seenDeliveries.delete(id);
  }
}, 60 * 1000).unref();

function truncate(text) {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

function buildTextFromPush(payload) {
  const repo = payload.repository?.full_name || 'unknown repo';
  const branch = (payload.ref || '').replace(/^refs\/heads\//, '') || 'unknown branch';
  const pusher = payload.pusher?.full_name || payload.pusher?.username || payload.sender?.login || 'someone';
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const lastCommit = commits[commits.length - 1];
  const message = lastCommit?.message?.split('\n')[0] || '(no commits)';
  const compareUrl = payload.compare_url || payload.repository?.html_url || '';

  return [
    `[${repo}] ${pusher} pushed to "${branch}" (${commits.length} commit(s))`,
    `Latest commit: ${message}`,
    compareUrl ? `Compare: ${compareUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildTextFromPullRequest(payload) {
  const repo = payload.repository?.full_name || 'unknown repo';
  const pr = payload.pull_request || {};
  const action = payload.action || 'updated';
  const author = pr.user?.login || pr.user?.full_name || 'someone';
  const title = pr.title || '(no title)';
  const head = pr.head?.ref || '?';
  const base = pr.base?.ref || '?';
  const url = pr.html_url || payload.repository?.html_url || '';

  return [
    `[${repo}] Pull request ${action} #${payload.number ?? pr.number ?? ''} by ${author}`,
    `${title}`,
    `${head} -> ${base}`,
    url ? `URL: ${url}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildText(event, payload) {
  let text;
  switch (event) {
    case 'push':
      text = buildTextFromPush(payload);
      break;
    case 'pull_request':
      text = buildTextFromPullRequest(payload);
      break;
    default: {
      const repo = payload.repository?.full_name || 'unknown repo';
      text = `[${repo}] Gitea event received: ${event}`;
    }
  }
  return truncate(text);
}

async function fireRoutine(text, deliveryId, event) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fireTimeoutMs);
  try {
    const res = await fetch(ANTHROPIC_FIRE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ROUTINE_TOKEN}`,
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (res.ok) {
      log('info', { deliveryId, event, result: 'forwarded', status: res.status });
      return;
    }

    const bodyText = await res.text().catch(() => '');
    const fields = { deliveryId, event, result: 'anthropic_error', status: res.status, body: bodyText.slice(0, 1000) };
    if (res.status === 429) {
      fields.retryAfter = res.headers.get('retry-after') || null;
    }
    log('error', fields);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    log('error', { deliveryId, event, result: 'fetch_failed', error: reason });
  } finally {
    clearTimeout(timeout);
  }
}

const rawBodySaver = (req, res, buf) => {
  req.rawBody = buf;
};

app.post(
  '/gitea-webhook',
  (req, res, next) => {
    const authHeader = req.header('Authorization') || '';
    if (!safeCompare(authHeader, GITEA_AUTH_HEADER)) {
      log('error', { result: 'unauthorized', reason: 'bad_auth_header' });
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  },
  express.json({ verify: rawBodySaver, limit: '2mb' }),
  (req, res, next) => {
    const signature = req.header('X-Gitea-Signature');
    if (!req.rawBody || !verifyGiteaSignature(req.rawBody, signature)) {
      log('error', { result: 'unauthorized', reason: 'bad_signature' });
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  },
  (req, res) => {
    const deliveryId = req.header('X-Gitea-Delivery') || null;
    const event = req.header('X-Gitea-Event') || 'unknown';

    if (isDuplicateDelivery(deliveryId)) {
      log('info', { deliveryId, event, result: 'duplicate_ignored' });
      return res.status(200).json({ status: 'duplicate_ignored' });
    }

    res.status(200).json({ status: 'accepted' });

    const text = buildText(event, req.body || {});
    log('info', { deliveryId, event, result: 'accepted' });
    fireRoutine(text, deliveryId, event);
  }
);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', { result: 'request_error', error: err.message });
  res.status(400).json({ error: 'bad_request' });
});

const port = Number(PORT);
app.listen(port, () => {
  log('info', { message: `Server listening on port ${port}` });
});
