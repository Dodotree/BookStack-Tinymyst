# File Sync WebSocket Node.js Implementation Plan

This document describes the end-to-end work needed to introduce a dedicated Node.js WebSocket service that streams incremental Typst edits from the browser to the Laravel filesystem (`storage/app/tinymist/page_<id>.typ`). Production will place the Node server behind Nginx on Ubuntu; local development can run the Node process directly.

## Architecture Overview

1. **Node WebSocket service** (new file: `node/file-sync/server.ts` or similar) handles authenticated connections, keeps the in-memory document state, and writes updates to disk.
2. **Laravel integration** (updates in `app/Entities/Tools/Tinymist/PageEditorData.php` or the relevant presenter) mints short-lived tokens and exposes WebSocket endpoint metadata to the frontend.
3. **Frontend integration** (edits in `resources/js/components/tinymist-editor.ts`) captures CodeMirror change sets, batches them, and pushes them over the socket while handling reconnects.
4. **Ops & deployment** documentation (`tinymist-devops/…`) captures Nginx proxy rules, systemd/PM2 configs, and health-check expectations.

## Authentication Strategy

Use a signed token so Node can verify the caller without a round-trip to Laravel.

1. **Token minting (PHP)** – In `PageEditorData.php` (or whichever class builds the editor payload), generate a JWT or HMAC of `{user_id, page_id, expires_at}` using a secret stored in `.env` (`TINYMIST_WS_SECRET`). Include the token and WebSocket URL in the JSON passed to the Blade view.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2.**Frontend hand-off** – The editor JS reads the token from the payload and connects with `new WebSocket(wssUrl, ['auth', token])` or by passing `?token=...` on the query string.
3. **Server verification (Node)** – On `connection`, the WebSocket service extracts the token, verifies the signature, checks `exp` and that the `page_id` matches the requested resource, and either accepts or closes the socket with code `4403`.
4. **Rotation / refresh** – When the frontend receives a `token-expiring` warning (or when reconnecting after a long idle period), it fetches a fresh token via a minimal Laravel endpoint (`/ajax/tinymist/ws-token` in `TinymistController.php`). Node accepts both the original and refreshed tokens as long as they verify.

## Connection Health & Lifecycle

Implement safeguards so the browser and Node processes recover automatically and prevent orphaned workers.

- **Heartbeat (client → server)** – Add a periodic JSON ping every 20 s (`{type: 'ping'}`) in `tinymist-editor.ts`; Node responds with `{type: 'pong'}`. If the client misses 3 pongs, it closes the socket and starts a reconnect backoff.
- **Server liveness sweep** – The Node service records the timestamp of the last message or pong for each socket. A background timer closes connections idle for >45 s, ensuring preview processes shut down when editors disappear.
- **Reconnect logic** – In the editor component, wrap `WebSocket` creation in a helper that retries with exponential backoff (5 s → 15 s → 30 s) and stops once the user navigates away or saves.
- **Metrics & logging** – Both sides log close codes (1000 normal vs 1006 network failure) and token validation errors. Expose a minimal `/healthz` endpoint from the Node service so systemd/PM2 can monitor it.

## Wire Protocol Between Browser and Node

1. **Change capture** – Extend `tinymist-editor.ts` with a CodeMirror `updateListener` that, whenever `transaction.docChanged`, serializes `transaction.changes.toJSON()` alongside the client’s current document version (`docVersion`). Debounce transmissions to ~150 ms to reduce chatter.

2. **Message payload** – Send JSON frames such as:

  ```json
  {
   "type": "changes",
   "pageId": 266,
   "docVersion": 42,
   "changes": { /* ChangeSet JSON from CodeMirror */ }
  }
  ```

  Reserve other message types for `ping`, `pong`, and optional server notifications.

3.**Server apply** – In the Node handler, load the current text into `@codemirror/state`’s `Text` object, reconstruct the `ChangeSet` from the JSON (`ChangeSet.fromJSON`), apply it, update the stored version, and write the resulting string back to `storage/app/tinymist/page_<id>.typ` using `fs.promises.writeFile`. Reject messages whose `docVersion` is behind the server’s version and request a resync.

4.**Resync flow** – Provide a `fullState` message type so the server can push the authoritative document when a client reconnects or drifts. The browser replaces its CodeMirror contents and resets the local version counter.

## Deployment & Nginx Proxy

Document the infrastructure changes in `tinymist-devops/UBUNTU_SETUP.md`:

- Run the Node service on localhost (e.g. `127.0.0.1:4000`) via systemd or PM2. Log to `/var/log/bookstack-ws.log`.
- Update the Nginx virtual host (`/etc/nginx/sites-available/bookstack`) with:

 ```nginx
 location /ws/tinymist/ {
   proxy_pass         http://127.0.0.1:4000/;
   proxy_http_version 1.1;
   proxy_set_header   Upgrade $http_upgrade;
   proxy_set_header   Connection "upgrade";
   proxy_set_header   Host $host;
   proxy_read_timeout 60s;
   proxy_buffering    off;
 }
 ```

- Reload Nginx after edits and ensure TLS certificates cover the chosen host name.

## Confirmed Decisions

- `app/Entities/Tools/Tinymist/PageEditorData.php` remains the source of truth for building the editor payload and minting WebSocket tokens.
- The authoritative Typst document persists on disk under `storage/app/tinymist/page_<id>.typ`; Node rewrites that file directly after applying each change set (no Redis backing required).
- Tinymist already watches the filesystem, so no explicit notification or HTTP call is required after writes—the preview process will pick up changes automatically.

With these decisions captured, the plan serves as the implementation checklist and documentation of the new WebSocket sync pathway.

`tsconfig.server.json`

  ```bash
  npm install -D typescript ts-node ts-node-dev @types/node @types/ws
  ```

```json
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^24.10.0",
    "@types/ws": "^8.18.1",
    "ts-node-dev": "^2.0.0",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^17.2.3",  // for proper loading of secret to node backend
```

Script entries** in `package.json`:

  ```json
  {
    "scripts": {
      "ws:dev": "ts-node-dev --respawn --transpile-only --project tsconfig.server.json node/file-sync/server.ts",
      "ws:build": "tsc --project tsconfig.server.json",
      "ws:start": "node dev/build/file-sync/server.js"
    }
  }
  ```

### Running

- Local hot-reload: `npm run ws:dev`.
- Build for deployment: `npm run ws:build` → use `node dist/node/...` in PM2/systemd.
- Diagnostic run without build: `npx ts-node --project tsconfig.server.json node/file-sync/server.ts`.

## How Token Expiration Works

1. **Token Decoding (`decodeAndStoreTokenExpiry`):**
   - When connecting, the JWT token is decoded (it's base64url encoded JSON)
   - The `exp` (expiration) field is extracted and stored in `wsTokenExpiry`
   - This gives us the exact Unix timestamp when the token expires

2. **Automatic Renewal Scheduling (`scheduleTokenRenewal`):**
   - After successful connection, a timeout is scheduled to renew the token
   - Renewal happens **60 seconds before expiration** (or halfway through token lifetime if it's less than 120 seconds)
   - This prevents the token from actually expiring during an active session

3. **Token Renewal (`renewToken`):**
   - Calls the backend endpoint `/ajax/tinymist/renew-ws-token`
   - Gets a fresh token with new expiration
   - Closes current WebSocket connection and reconnects with new token
   - Schedules the next renewal

4. **Graceful Handling:**
   - If token is already expired, it renews immediately
   - Reconnections use the stored (possibly renewed) token
   - All timeouts are cleaned up on editor destruction

## Flow

```log
1. Initial connection with token (15 min TTL)
2. Token decoded, expiry stored (e.g., 900 seconds from now)
3. Renewal scheduled for 840 seconds (14 minutes)
4. At 14 minutes, new token requested from backend
5. New token received with fresh 15 min expiry
6. WebSocket reconnects with new token
7. Next renewal scheduled for 14 minutes later
8. Cycle repeats as long as editor is open
```
