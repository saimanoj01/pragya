# Pragya OAuth Refresh Proxy (Cloudflare Worker)

A tiny, **100% stateless** Cloudflare Worker (zero dependencies, zero database/KV) that enables **permanent background sign-in** on the Pragya Android/iOS PWA without popups, redirects, or cross-site cookies.

## How it works

1. When `VITE_GOOGLE_AUTH_PROXY_URL` (or the runtime **Auth Proxy URL** setting) is configured, Pragya switches from Google's 1-hour implicit flow to standard **OAuth 2.0 Authorization Code + PKCE (`access_type=offline`)**.
2. After you sign in once, this Worker exchanges the authorization code with Google, encrypts the returned `refresh_token` with **AES-256-GCM** (authenticated against your origin and Client ID using `TOKEN_CIPHER_KEY`), and returns the sealed ciphertext to your device.
3. Whenever your 1-hour Google access token expires (or on PWA cold launch / resume), Pragya silently calls `POST /refresh` in the background to mint a fresh access token.
4. **Privacy:** The Worker stores nothing and never sees your books, notes, or Google Sheets. All Sheets/Drive traffic still goes directly from your phone to `googleapis.com`.

---

## One-time setup (~5 minutes)

### 1. Google Cloud Console (remove the 7-day Testing limit)

1. Open [Google Cloud Console → Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients) and open your existing **Web application** OAuth Client used by Pragya.
2. Confirm your **Authorized Redirect URIs** include your exact Pragya URL (e.g. `https://<username>.github.io/pragya/` and `http://localhost:3000/`).
3. Copy your **Client ID** and **Client Secret** (if you lost the secret, click **Add secret**).
4. Open **Audience** (OAuth Consent Screen) and click **Publish App** to move from **Testing** → **In production**.
   - **Why:** In Testing mode, Google hard-expires refresh tokens after **7 days**. Publishing removes the 7-day expiry so your phone stays logged in indefinitely.
   - **Personal use / friends (< 100 users):** You do **not** need Google app verification. During a user's very first sign-in, click **Advanced → Go to Pragya (unsafe)** once.

### 2. Deploy the Worker (Cloudflare free tier)

Edit `ALLOWED_ORIGINS` in [`wrangler.toml`](./wrangler.toml) if your GitHub Pages or custom domain differs, then run:

```bash
cd workers/oauth-proxy

# 1. Log in to Cloudflare once
npx wrangler login

# 2. Deploy the Worker to https://pragya-oauth-proxy.<your-subdomain>.workers.dev
npx wrangler deploy

# 3. Set the 3 required secrets (stored encrypted on Cloudflare; live immediately)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

# 4. Generate and store a random 32-byte AES-256-GCM sealing key
openssl rand -base64 32 | npx wrangler secret put TOKEN_CIPHER_KEY
```

Verify the deployment:

```bash
curl https://pragya-oauth-proxy.<your-subdomain>.workers.dev/health
# Expected: {"ok":true,"service":"pragya-oauth-proxy","configured":true}
```

### 3. Connect Pragya to your Worker

Choose either option:

- **Hosted for everyone using your GitHub Pages deployment (recommended):**
  Add a GitHub Actions secret named `VITE_GOOGLE_AUTH_PROXY_URL` in **Repository Settings → Secrets and variables → Actions** set to your Worker URL (`https://pragya-oauth-proxy.<your-subdomain>.workers.dev`), then re-run or push to `main`.
- **Self-hosted / per-device override:**
  Open Pragya **Login** (expand *Google OAuth Client ID*) or **Settings → Google OAuth**, paste your Worker URL into **Auth Proxy URL**, click **Save**, and sign in with Google once.

---

## Rotating keys / revoking all sessions

Run `openssl rand -base64 32 | npx wrangler secret put TOKEN_CIPHER_KEY` to immediately invalidate every sealed refresh token issued by your Worker.
