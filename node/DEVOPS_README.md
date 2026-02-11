# .env settings needed

The key for authentication tokens in the env. file needed both for node server and Laravel

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

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

## Requirements

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
