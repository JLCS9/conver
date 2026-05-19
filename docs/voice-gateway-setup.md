# Voice gateway — operator setup

> One-time setup for the voice WS gateway. Targeted at the operator (Jose),
> not at users of the app. Required before the first `voice-gateway` container
> can serve traffic.

## What the voice gateway does

The mobile app opens a WebSocket to `wss://api.converflow.tech/voice` (proxied
by host nginx). The voice-gateway container terminates that connection,
verifies the user's Clerk session, enforces per-user caps, and then opens an
upstream WebSocket to Google Gemini Live API using `GEMINI_API_KEY`.

Audio is piped bidirectionally. The Gemini API key never leaves the VPS.

## What you need

- An active Google AI Studio API key from your `converf` GCP project. You
  said you already have one (`GOOGLE_GENERATIVE_AI_API_KEY` in your notes).
  This is what we'll call `GEMINI_API_KEY` in the env files.
- SSH access to the VPS as root (you already have this).

## Setup steps

### 1. Pick the model id

Based on May 2026 verification: `gemini-3.5-flash` (GA May 19). If the GCP
console shows a different "Live API" model name (e.g. `gemini-3.5-flash-live`
or `gemini-3.5-flash-native-audio`), prefer that and let me know — we update
the env accordingly.

### 2. Put the API key + model on the VPS

```bash
ssh root@187.77.166.246

cd /opt/converflow
nano backend/.env.local
```

Append the following lines (replace with your real key):

```
# --- Google Gemini Live ---
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
GEMINI_MODEL=gemini-3.5-flash
GEMINI_LIVE_WS_URL=wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
```

Save and exit.

### 3. (Skip for now — will be done in the next commits)

Once `voice-gateway` container is added (Commits 2-3 of Week 3 Day 1),
you'll re-deploy with:

```bash
cd /opt/converflow && ./scripts/deploy.sh
```

The deploy script will pick up the new compose service automatically.

## Security notes

- `GEMINI_API_KEY` is server-only. The mobile app never sees it.
- Rate-limit Gemini API key in Google AI Studio dashboard (set a quota cap so
  a bug in our gateway can't burn unbounded $$).
- If the key ever leaks (commit, log paste), rotate it in AI Studio
  immediately — that invalidates the old one in <60 seconds.

## What we do NOT need (vs. what early research suggested)

Earlier research talked about minting Google IAM access tokens via
`iamcredentials.googleapis.com:generateAccessToken` and handing them to the
mobile client. That flow is for the "direct mobile ↔ Google" architecture
(Option A). Since we picked Option B (backend proxy), the mobile client
never authenticates to Google at all — our gateway does it with the static
API key. No Service Account JSON, no key file mounting, no token minting.
