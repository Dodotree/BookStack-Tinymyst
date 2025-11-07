import { config } from 'dotenv';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import { ChangeSet, Text } from '@codemirror/state';

// Load .env file from project root
config({ path: join(process.cwd(), '.env') });

type AuthToken = {
  user_id: number;
  page_id: number;
  exp: number;
};

type IncomingMessagePayload =
  | { type: 'ping' }
  | {
      type: 'changes';
      pageId: number;
      docVersion: number;
      changes: unknown; // serialized ChangeSet
    }
  | {
      type: 'updateToken';
      token: string;
    };

type OutgoingMessagePayload =
  | { type: 'pong' }
  | {
      type: 'ack';
      pageId: number;
      docVersion: number;
    }
  | {
      type: 'fullState';
      pageId: number;
      docVersion: number;
      content: string;
    }
  | {
    type: 'error';
    code: string;
    message: string;
  };

type ConnectionContext = {
  socket: WebSocket;
  pageId: number;
  userId: number;
  docVersion: number;
  lastSeen: number;
};

const PORT = Number(process.env.FILE_WS_PORT ?? 4000);
const HOST = process.env.FILE_WS_HOST ?? '127.0.0.1';
const JWT_SECRET = process.env.TINYMIST_WS_SECRET ?? 'dev-secret';
const STORAGE_ROOT = process.env.TYPST_STORAGE_ROOT ?? join(process.cwd(), 'storage', 'app', 'tinymist');
const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 45_000;

const connections = new Map<WebSocket, ConnectionContext>();

function verifyToken(token: string): AuthToken {
  try {
    console.log('Verifying token:', { token: token.substring(0, 20) + '...', secretLength: JWT_SECRET.length });
    const decoded = jwt.verify(token, JWT_SECRET) as AuthToken;
    console.log('Token verified successfully:', { user_id: decoded.user_id, page_id: decoded.page_id, exp: decoded.exp });
    return decoded;
  } catch (err) {
    console.error('Token verification failed:', err);
    throw new Error('INVALID_TOKEN');
  }
}

function loadDocument(pageId: number): { content: string; docVersion: number } {
  const filePath = join(STORAGE_ROOT, `page_${pageId}.typ`);
  try {
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    return { content, docVersion: 0 };
  } catch (err) {
    console.error('Failed to read document', { pageId, err });
    throw new Error('DOC_READ_FAILED');
  }
}

function persistDocument(pageId: number, content: string) {
  const filePath = join(STORAGE_ROOT, `page_${pageId}.typ`);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  } catch (err) {
    console.error('Failed to write document', { pageId, err });
    throw new Error('DOC_WRITE_FAILED');
  }
}

function send(ws: WebSocket, payload: OutgoingMessagePayload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handleChanges(ctx: ConnectionContext, msg: Extract<IncomingMessagePayload, { type: 'changes' }>) {
  if (msg.pageId !== ctx.pageId) {
    send(ctx.socket, { type: 'error', code: 'PAGE_MISMATCH', message: 'Page mismatch' });
    return;
  }

  if (msg.docVersion <= ctx.docVersion) {
    send(ctx.socket, {
      type: 'error',
      code: 'VERSION_OUTDATED',
      message: 'Client version outdated, request full resync',
    });
    const { content } = loadDocument(ctx.pageId);
    send(ctx.socket, {
      type: 'fullState',
      pageId: ctx.pageId,
      docVersion: ctx.docVersion,
      content,
    });
    return;
  }

  const { content: currentContent } = loadDocument(ctx.pageId);
  const text = Text.of(currentContent.split('\n'));

  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.fromJSON(msg.changes as any);
  } catch (err) {
    console.error('Failed to parse changeset', { pageId: ctx.pageId, err });
    send(ctx.socket, { type: 'error', code: 'INVALID_CHANGESET', message: 'Failed to parse changeset' });
    return;
  }

  let updated: string;
  try {
    updated = changeSet.apply(text).toString();
  } catch (err) {
    console.error('Failed to apply changeset', { pageId: ctx.pageId, err });
    send(ctx.socket, { type: 'error', code: 'CHANGESET_APPLY_FAILED', message: 'Failed to apply changeset' });
    return;
  }

  try {
    persistDocument(ctx.pageId, updated);
  } catch (err) {
    send(ctx.socket, { type: 'error', code: 'WRITE_FAILED', message: 'Failed to persist document' });
    return;
  }

  ctx.docVersion = msg.docVersion;
  send(ctx.socket, { type: 'ack', pageId: ctx.pageId, docVersion: ctx.docVersion });
}

function handleTokenUpdate(ctx: ConnectionContext, msg: Extract<IncomingMessagePayload, { type: 'updateToken' }>) {
  try {
    console.log('[File Sync] Token update request', { pageId: ctx.pageId, userId: ctx.userId });
    const payload = verifyToken(msg.token);

    // Verify it's for the same page
    if (payload.page_id !== ctx.pageId) {
      console.error('[File Sync] Token update failed: page mismatch', {
        contextPageId: ctx.pageId,
        tokenPageId: payload.page_id
      });
      send(ctx.socket, { type: 'error', code: 'PAGE_MISMATCH', message: 'Token is for different page' });
      return;
    }

    // Update context with new user ID (in case user changed)
    ctx.userId = payload.user_id;
    console.log('[File Sync] Token updated successfully', { pageId: ctx.pageId, userId: ctx.userId });

    // Send acknowledgment
    send(ctx.socket, { type: 'ack', pageId: ctx.pageId, docVersion: ctx.docVersion });
  } catch (err) {
    console.error('[File Sync] Token update failed:', err);
    send(ctx.socket, { type: 'error', code: 'INVALID_TOKEN', message: 'Token verification failed' });
  }
}

function processMessage(ctx: ConnectionContext, raw: RawData) {
  let msg: IncomingMessagePayload;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    send(ctx.socket, { type: 'error', code: 'BAD_JSON', message: 'Invalid JSON' });
    return;
  }

  ctx.lastSeen = Date.now();

  switch (msg.type) {
    case 'ping':
      send(ctx.socket, { type: 'pong' });
      return;
    case 'changes':
      handleChanges(ctx, msg);
      return;
    case 'updateToken':
      handleTokenUpdate(ctx, msg);
      return;
    default:
      send(ctx.socket, { type: 'error', code: 'UNKNOWN_TYPE', message: 'Unsupported message type' });
      return;
  }
}

function performHandshake(request: IncomingMessage): { token: string; pageId: number } {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token') || request.headers['sec-websocket-protocol'];
  if (!token) {
    throw new Error('MISSING_TOKEN');
  }

  const parsed = verifyToken(Array.isArray(token) ? token[0] : token);
  return { token: Array.isArray(token) ? token[0] : token, pageId: parsed.page_id };
}

function createContext(socket: WebSocket, tokenPayload: AuthToken, initialVersion: number): ConnectionContext {
  return {
    socket,
    pageId: tokenPayload.page_id,
    userId: tokenPayload.user_id,
    docVersion: initialVersion,
    lastSeen: Date.now(),
  };
}

function pruneStaleConnections() {
  const now = Date.now();
  for (const [ws, ctx] of connections.entries()) {
    if (now - ctx.lastSeen > STALE_TIMEOUT_MS) {
      console.warn('Closing stale connection', { pageId: ctx.pageId, userId: ctx.userId });
      ws.close(4000, 'Idle timeout');
      connections.delete(ws);
    }
  }
}

function bootstrap() {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket, request) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const tokenParam = url.searchParams.get('token') || request.headers['sec-websocket-protocol'];
      console.log('Connection attempt:', { url: request.url, hasToken: !!tokenParam });

      if (!tokenParam) {
        console.error('No token provided');
        socket.close(4401, 'Missing token');
        return;
      }

      const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
      console.log('Extracted token:', token.substring(0, 30) + '...');
      const payload = verifyToken(token);
      const { content } = loadDocument(payload.page_id);
      const ctx = createContext(socket, payload, 0);
      connections.set(socket, ctx);

      send(socket, {
        type: 'fullState',
        pageId: payload.page_id,
        docVersion: ctx.docVersion,
        content,
      });

      socket.on('message', (raw) => processMessage(ctx, raw));

      socket.on('close', (code, reason) => {
        console.log('Socket closed', { code, reason: reason.toString(), pageId: ctx.pageId, userId: ctx.userId });
        connections.delete(socket);
      });

      socket.on('error', (err) => {
        console.error('Socket error', { err, pageId: ctx.pageId, userId: ctx.userId });
      });
    } catch (err) {
      console.error('Failed handshake', { err });
      socket.close(4403, 'Unauthorized');
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Typst file-sync WebSocket listening on ${HOST}:${PORT}`);
  });

  setInterval(pruneStaleConnections, HEARTBEAT_INTERVAL_MS);
}

bootstrap();
