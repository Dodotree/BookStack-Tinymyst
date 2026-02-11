# Authentication Strategy

Use a signed token so Node can verify the caller without a round-trip to Laravel.

1. **Token minting (PHP)** – In `TinymistPreviewManager.php` (or whichever class builds the editor payload), generate a JWT or HMAC of `{user_id, page_id, expires_at}` using a secret stored in `.env` (`TINYMIST_WS_SECRET`). Include the token and WebSocket URL in the JSON passed to the Blade view.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

2.**Frontend hand-off** – The editor JS reads the token from the payload and connects with `new WebSocket(wssUrl, ['auth', token])` or by passing `?token=...` on the query string. Passing it as parameter could be more stable method to survive server proxies.
3. **Server verification (Node)** – On `connection`, the WebSocket service extracts the token, verifies the signature, checks `exp` and that the `page_id` matches the requested resource, and either accepts or closes the socket with code `4403`.
4. **Rotation / refresh** – When the frontend receives a `token-expiring` warning (or when reconnecting after a long idle period), it fetches a fresh token via a minimal Laravel endpoint (`/ajax/tinymist/renew-ws-token` in `TinymistController.php`). Node accepts both the original and refreshed tokens as long as they verify.

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
