/* eslint-disable no-console */
/**
 * TelePorter stub — for local integration smoke while the real TelePorter
 * API is being built in parallel.
 *
 * Matches the locked contract in the user's brief:
 *   POST   /subscribers                       — provision a workspace bot
 *   GET    /subscribers/:workspaceId          — fetch bot info
 *   DELETE /subscribers/:workspaceId          — retire
 *   POST   /chats/verify                      — return verdict
 *   POST   /messages                          — queue/schedule a message
 *   POST   /messages/:id/cancel               — cancel a queued/scheduled
 *   GET    /messages/:id                      — fetch a message
 *
 * Auth: header X-TelePorter-Service-Key must match TELEPORTER_SERVICE_KEY env.
 *
 * Run: `npm run stub:teleporter` (defaults to port 4000).
 */
import * as http from 'http';
import * as crypto from 'crypto';

const PORT = parseInt(process.env.STUB_PORT || '4000', 10);
const SECRET = process.env.TELEPORTER_SERVICE_KEY || 'stub-secret';
const CALLBACK_DELAY_MS = parseInt(process.env.STUB_CALLBACK_DELAY_MS || '500', 10);

interface Message {
  messageId: string;
  status: 'queued' | 'scheduled' | 'sent' | 'failed' | 'cancelled';
  scheduledAt?: string;
  subscriberWorkspaceId: string;
  chatRef: string;
  callbackUrl: string;
  idempotencyKey: string;
}

const subscribers = new Map<string, { subscriberId: string; botUsername: string; status: string; inviteHint?: string }>();
const messages = new Map<string, Message>();
const idempotency = new Map<string, string>(); // key → messageId

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function fireCallback(msg: Message, event: 'message.sent' | 'message.failed') {
  if (!msg.callbackUrl) return;
  const payload: Record<string, unknown> = {
    event,
    subscriberWorkspaceId: msg.subscriberWorkspaceId,
    messageId: msg.messageId,
    occurredAt: new Date().toISOString(),
  };
  if (event === 'message.sent') payload.providerMessageId = `tg_${Math.floor(Math.random() * 1e6)}`;
  if (event === 'message.failed') {
    payload.errorCode = 'STUB_ERROR';
    payload.errorMessage = 'simulated failure';
  }
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const url = new URL(msg.callbackUrl);
  const req = http.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-TelePorter-Signature': `sha256=${sig}`,
      },
    },
    (res) => res.resume(),
  );
  req.on('error', (e) => console.error(`[stub] callback failed:`, e.message));
  req.write(body);
  req.end();
}

const server = http.createServer(async (req, res) => {
  if (req.headers['x-teleporter-service-key'] !== SECRET) {
    return send(res, 401, { message: 'invalid service key' });
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const method = req.method || 'GET';

  try {
    if (method === 'POST' && url.pathname === '/subscribers') {
      const body = JSON.parse(await readBody(req));
      const ws = body.subscriberWorkspaceId;
      const sub = {
        subscriberId: `sub_${crypto.randomBytes(6).toString('hex')}`,
        botUsername: `sigcore_${ws.slice(0, 8)}_bot`,
        status: 'ready',
        inviteHint: `Add @sigcore_${ws.slice(0, 8)}_bot to your channel as admin with Post Messages.`,
      };
      subscribers.set(ws, sub);
      return send(res, 200, sub);
    }

    const subMatch = url.pathname.match(/^\/subscribers\/([^/]+)$/);
    if (subMatch && method === 'GET') {
      const sub = subscribers.get(subMatch[1]);
      if (!sub) return send(res, 404, { message: 'subscriber not found' });
      return send(res, 200, sub);
    }
    if (subMatch && method === 'DELETE') {
      subscribers.delete(subMatch[1]);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && url.pathname === '/chats/verify') {
      const body = JSON.parse(await readBody(req));
      return send(res, 200, {
        status: 'ready',
        chatRef: body.chatRef,
        membership: 'admin',
        postPermission: true,
        slowMode: 0,
        joinToSend: false,
        blockers: [],
        warnings: [],
        probeRan: body.probe === true,
      });
    }

    if (method === 'POST' && url.pathname === '/messages') {
      const body = JSON.parse(await readBody(req));
      const existing = idempotency.get(body.idempotencyKey);
      if (existing) {
        const m = messages.get(existing);
        return send(res, 200, { messageId: m.messageId, status: m.status, scheduledAt: m.scheduledAt });
      }
      const messageId = `msg_${crypto.randomBytes(6).toString('hex')}`;
      const msg: Message = {
        messageId,
        status: body.scheduledAt ? 'scheduled' : 'queued',
        scheduledAt: body.scheduledAt,
        subscriberWorkspaceId: body.subscriberWorkspaceId,
        chatRef: body.chatRef,
        callbackUrl: body.callbackUrl,
        idempotencyKey: body.idempotencyKey,
      };
      messages.set(messageId, msg);
      idempotency.set(body.idempotencyKey, messageId);
      setTimeout(() => {
        const m = messages.get(messageId);
        if (m && m.status !== 'cancelled') {
          m.status = 'sent';
          fireCallback(m, 'message.sent');
        }
      }, CALLBACK_DELAY_MS);
      return send(res, 200, { messageId, status: msg.status, scheduledAt: msg.scheduledAt });
    }

    const cancelMatch = url.pathname.match(/^\/messages\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const m = messages.get(cancelMatch[1]);
      if (!m) return send(res, 404, { message: 'not found' });
      if (m.status === 'sent') return send(res, 409, { message: 'already sent' });
      m.status = 'cancelled';
      return send(res, 200, { messageId: m.messageId, status: m.status });
    }

    const getMatch = url.pathname.match(/^\/messages\/([^/]+)$/);
    if (getMatch && method === 'GET') {
      const m = messages.get(getMatch[1]);
      if (!m) return send(res, 404, { message: 'not found' });
      return send(res, 200, { messageId: m.messageId, status: m.status, scheduledAt: m.scheduledAt });
    }

    send(res, 404, { message: `no route for ${method} ${url.pathname}` });
  } catch (e: any) {
    send(res, 500, { message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`TelePorter stub listening on http://localhost:${PORT}`);
  console.log(`Service key: ${SECRET}`);
  console.log(`Callback delay: ${CALLBACK_DELAY_MS}ms`);
});
