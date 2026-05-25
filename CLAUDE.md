# Converflow — Project context for Claude

> Live decisions and project state. Future Claude sessions read this first.
> Last updated: 2026-05-25 (Week 3 Day 3 closed — WS open end-to-end on SDK 56).

## Product

Mobile app for Spanish-speaking professionals to practice daily English conversation in short sessions (5-10 min) with an AI voice agent. iOS first; Android in parallel but not published until month 3-4. Positioning: "the daily English speaking habit" — closer to a fitness app than a course. Push notification at the user's chosen daily time is the habit engine.

V1 vertical: developers / tech roles. Other roles (sales, hospitality) are post-MVP.

## Founder context

Solo founder Jose Luis Castedo Sánchez (CSO Digital SL). ~10-12 weeks to TestFlight beta. Limited budget. Unit economics matter from day one because the voice IA infra is expensive.

Naming caveat: there is a prior product also called "Converflow" (B2B collections SaaS). For everything in this repo, "Converflow" means the English-practice mobile app. Two unrelated products under the same parent company.

## Stack (locked)

| Layer | Choice |
|------|--------|
| Mobile framework | Expo SDK 51+ (dev builds, managed workflow — NOT Expo Go) |
| Mobile router | Expo Router (file-based) |
| Language | TypeScript strict |
| Styling | NativeWind v4 |
| Mobile UI primitives | React Native Reusables |
| Backend framework | Next.js 15 (App Router, API-only, standalone build) |
| Backend hosting | Hostinger VPS in Paris — Docker Compose for the Next.js container; host nginx (pre-existing on the VPS for other projects) fronts it with certbot SSL |
| Auth | Clerk (`@clerk/expo` on mobile, `@clerk/nextjs` server-side) |
| Database | Supabase (Postgres + RLS), region eu-west |
| Voice IA | **Gemini Live API** (Google AI Studio / Vertex AI, `europe-west1`) |
| Audio capture/playback | expo-av (fallback to expo-audio if streaming PCM has issues) |
| Payments primary (EU) | Stripe web checkout via DMA "Steering" |
| Payments fallback (non-EU) | Apple IAP + Google Play Billing |
| Email | Resend |
| Analytics | PostHog (EU hosted) |
| Crash reporting | Sentry |
| Push | Expo Notifications + Expo Push Service |
| Builds | EAS Build |
| OTA | EAS Update (runtimeVersion pinned to sdkVersion) |
| Domain (final) | converflow.ai (registrar transfer in progress, ETA a few days) |
| Domain (transition) | converflow.tech (used during the .ai transfer; swap is a 1-line Caddyfile + env change) |
| iOS bundle ID | ai.converflow.app |
| Backend API | api.converflow.tech → VPS 187.77.166.246 (Hostinger Paris, ~38ms RTT from Madrid measured) |

### Voice provider rationale

The original brief assumed OpenAI Realtime API. After explicit prioritization of latency + price, switched to Gemini Live (~3-5× cheaper than OpenAI Realtime, EU endpoint available). A Phase 2 migration to a Pipecat self-hosted pipeline (Deepgram + Groq + Deepgram Aura) is planned for month 3-4+ once usage justifies the engineering cost. Mobile code lives behind a `VoiceSession` abstraction so the migration touches only `mobile/src/services/voice/`.

## Repo layout

```
conver/
├── mobile/          Expo app (scaffolded in Commit 3)
├── backend/         Next.js 15 API on the VPS (scaffolded in Commit 2)
├── shared/          Types + zod schemas used by both
├── supabase/        SQL migrations + seed (Supabase GitHub integration auto-applies)
├── scripts/         Operational scripts (VPS setup, deploy helpers)
└── .github/         CI/CD workflows
```

## Scope: MVP

In:
- Onboarding (~60s): welcome → push permission → role → quick level self-assessment → goal → daily session time → mic permission
- Auth via Clerk (Apple Sign-in is mandatory if any social login is offered)
- Home: big "Start session" button, weekly streak, total minutes, next scheduled push
- Voice session screen: 5-10 min conversation, live transcript, end button, no interruptive corrections
- End-of-session: 2-3 concrete improvement points, streak updated, optional share
- Settings: subscription management, account deletion, progress export, contact
- Paywall: at 5-min/day cap for free tier

Out (backlog):
- Android publish (build in parallel, hold release)
- On-device IA
- Sales / Hospitality verticals
- B2B tier
- Other source languages
- Sophisticated level assessment
- Social features, leaderboards
- Apple Watch / widgets
- Custom voice selection

## Pricing

- Free: 5 min/day, basic feedback, lighter model
- Premium: €9.99/month or €69/year, unlimited (soft cap warning at 60 min/day), frontier model, detailed feedback

EU: Stripe web checkout (saves 15-30% Apple fee via DMA). Non-EU: Apple IAP / Google Play Billing fallback. Region detected server-side.

## Development principles

- Functionality first, optimization second — but cost monitoring from day one. Every voice session writes `estimated_cost_cents` to DB.
- Mobile-native patterns (bottom tabs, gestures, SafeArea, haptics). Not web-wrapped.
- Latency is the most important product metric. Target <800 ms time-to-first-audio. Regressions get discussed before merging.
- iOS audio session correctness: handle interruptions (call, alarm), headphones plug/unplug, route changes.
- Backlog anything outside MVP scope. No "while we're here" features.
- No large refactors without asking.
- Tests on business logic (streak calc, minute accounting, subscription state). No UI coverage obsession.
- Cost guardrails everywhere: hard server-side caps, no infinite loops, hard timeouts.
- Code (vars, fns, files, comments) in English. UI strings and product copy in Spanish.

## Working with Claude

1. **Plan before coding.** Propose a plan first: files to touch, decisions, open questions. Wait for approval.
2. **Surface trade-offs** explicitly — don't pick in silence.
3. **Run tests** and report results before declaring complete.
4. **Be honest about uncertainty.** If an API has changed, say so and consult docs.
5. **Clear commit messages.** Present tense, what changed, why.
6. **One feature per commit / PR.**

## Known risks

1. **App Store AI rejection** — keep store copy conservative (no "powered by Gemini"). Include real product value beyond the chat.
2. **iOS audio session** — interruptions, background, headphones, route changes. Test on real devices.
3. **WebSocket reliability** — Gemini Live can drop. Retry logic + visual reconnection state + graceful resume from transcript.
4. **Ephemeral credentials** — app never sees the Google service account key. Backend mints short-lived tokens per session.
5. **DMA payments flow** — implement Apple's "Steering" pattern correctly in EU or risk rejection.
6. **Voice IA cost runaway** — hard server-side caps (12 min/session, 90 min/day), watchdog timer on client, separate Google Cloud project with budget alerts.
7. **Push notification delivery** — daily push is the habit motor. Track receipts in `push_deliveries`; in-app fallback if missed.
8. **Microphone permission UX** — educational pre-prompt before the iOS dialog; deep-link to Settings if denied.
9. **Latency from Spain** — VPS Paris (~38 ms RTT from Madrid measured). Gemini Live in `europe-west1` keeps the whole path within EU.
10. **Clerk + Supabase JWT** — JWT template in Clerk must target the Supabase audience. Test token refresh during long sessions.

## Operational ground truth

- VPS: Hostinger `srv1433126.hstgr.cloud` / 187.77.166.246, Paris, Debian 13, root for setup. Deploy user `deploy` exists but is dormant until we add CI/CD. App lives at `/opt/converflow/` on the VPS.
- Backend deploy is **manual pull-based for MVP**: locally we push to `main`, on the VPS `cd /opt/converflow && ./scripts/deploy.sh` does `git pull --ff-only && docker compose up -d --build`. Automated CI/CD via GitHub Actions is backlog for month 3+.
- The backend container binds only to `127.0.0.1:8082`. Public traffic enters through host nginx (already running for other projects on this VPS), with a vhost at `/etc/nginx/sites-enabled/api.converflow.tech` (template at `scripts/nginx-api.converflow.tech.conf`). SSL via certbot's `--nginx` plugin, auto-renewing.
- `git pull` from `/opt/converflow` must be run with `git config --global --add safe.directory /opt/converflow` exception set (one-time) because the dir is owned by `deploy` but commands typically run as root.
- Supabase project is connected to this repo via the Supabase GitHub integration. Migrations in `supabase/migrations/` auto-apply on push to `main`.
- Mobile builds via EAS Build (`mobile/eas.json`). Distribution: TestFlight (iOS) for beta and prod; Google Play internal track (Android, after month 3-4).
- Domain: currently `api.converflow.tech` while `converflow.ai` finishes its registrar transfer. To swap once `.ai` is live: edit Caddyfile (one block), edit `mobile/.env*` (one variable), redeploy. Bundle ID stays `ai.converflow.app`.

## Commit log of decisions

- 2026-05-17: Repo bootstrap. Locked Gemini Live for v1 voice; Hostinger Paris VPS over Vercel; bundle ID `ai.converflow.app`; three-commit scaffolding plan (repo skeleton → backend deploy → mobile + supabase).
- 2026-05-18: Switched to manual pull-based deploy (`scripts/deploy.sh`) instead of GitHub Actions CI/CD — simpler for MVP, can upgrade later. Transition domain `api.converflow.tech` until `.ai` registrar transfer completes.
- 2026-05-18 (later): Dropped dockerized Caddy in favor of host nginx + certbot. Reason: VPS already runs nginx for other projects on ports 80/443 — duplicating reverse proxies would conflict. Backend container now binds `127.0.0.1:8082`; nginx vhost in `scripts/nginx-api.converflow.tech.conf`.
- 2026-05-18 (later, Commit 3a): Initial Supabase schema (`supabase/migrations/20260518200000_init.sql`). Eight tables (users, daily_prompts, sessions, subscriptions, voice_usage_logs, push_tokens, streaks, push_deliveries) with RLS via `public.clerk_user_id()` helper. Clerk integrated via Supabase Third-Party Auth — JWTs from Clerk pass straight to RLS through `auth.jwt() ->> 'sub'`.
- 2026-05-18 (later, Commit 3b): Backend Clerk integration via `@clerk/nextjs@^6`. `middleware.ts` protects `/api/me` (health stays public). `lib/supabaseAdmin.ts` lazy-inits the service_role client. `GET /api/me` upserts the user row from Clerk and returns the profile. Clerk's `auth.protect()` returns 404 (not 401) for unauthenticated API calls — this is by design.
- 2026-05-18 (later, Commit 3c): Expo SDK 51 mobile app scaffolded. Routes: `(auth)/sign-in|sign-up|verify` (email + password), `(app)/index` (home with `/api/me` call). Clerk via `@clerk/clerk-expo@^2` with `expo-secure-store` token cache. `src/lib/api.ts` typed-fetch wrapper auto-attaches Clerk Bearer token. Bundle ID `ai.converflow.app`, scheme `converflow`, mic usage description set for App Store. Closes the end-to-end auth loop: Expo → Clerk JWT → backend → Supabase upsert → user row returned.
- 2026-05-19: **Week 1 milestone closed — end-to-end auth loop verified live on iPhone 17 Pro (iOS 26.5) Simulator.** First local dev build with Xcode 26.5 + CocoaPods 1.16.2 succeeded cleanly despite the 2-year gap between SDK 51 and iOS 26.5 (only benign `-lc++` duplicate-libraries warning). Two iterations: (1) Expo Go failed at runtime with `Cannot find native module 'ExpoCryptoAES'` — confirmed Expo Go is not viable for this stack, must use dev builds. (2) First dev build failed with `Cannot find native module 'ExpoWebBrowser'`; resolved by `npx expo install expo-web-browser expo-auth-session` (Clerk peer deps the original scaffold omitted). Second dev build ran clean: sign-up → email code → verify → home renders the Supabase user row returned by `/api/me`. Known follow-up: `expo-apple-authentication` is still missing and will be needed before we ship any social sign-in (App Store guideline). Side note: had to free ~21 GB from `~/.npm` and `~/.cache` mid-session — flagging that the dev loop is disk-hungry (mobile/node_modules 1.1 GB + ios/ build artifacts ~3 GB).
- 2026-05-19 (later): **Week 2 milestone closed — full onboarding wizard live on simulator.** Sign-up → 7 screens → `public.users` row populated with role/level/goal/daily_session_time/timezone/onboarding_completed_at in ~55s. Twelve commits land: NativeWind v4 + Tailwind (pinned at `nativewind@4.1.23` because 4.2.x pulls in `react-native-worklets/plugin` which requires reanimated 4); Zustand wizard store; `expo-notifications` + `@react-native-community/datetimepicker` (native rebuild); backend `/api/onboarding` and `/api/push/register` with manual validation; root redirect gating on `onboarding_completed_at`; seven onboarding screens (welcome/notifications/role/level/goal/time/microphone), all NativeWind-styled. Two infra bugs caught and fixed (both worth remembering for future setup):
  1. **Two Clerk projects mismatch.** The committed `mobile/.env.example` had a publishable key for the `contentIA` Clerk project (`nice-chamois-35`), but the VPS backend was wired against `converf` (`immune-rodent-31`). JWTs minted by mobile failed verification → 404 from Clerk middleware. Fixed by aligning `mobile/.env.example` to converf and updating `mobile/.env.local` out-of-band.
  2. **`SUPABASE_URL` had `/rest/v1/` suffix.** The JS client adds that path itself, so the final URL doubled it and PostgREST returned "Invalid path specified in request URL" on every upsert. Fixed by `sed`-stripping the suffix in `backend/.env.local` on the VPS and recreating the container. Also expanded `[/api/me]` error logging to surface `code/hint/details` from PostgREST errors instead of just `message` — the message alone was useless for diagnosis. Known follow-ups: `expo-av` still missing (Week 3 needs it for the real mic permission and audio recording); mic permission UI is currently educational-only, the actual `Audio.requestPermissionsAsync()` call is deferred to the first voice session per Apple's "ask at point of use" guideline.
- 2026-05-19 (later still, pre-Week-3 prep): **Backend infra hardened ahead of voice work.** Added zod (`^4.4.3`) — `lib/schemas.ts` centralizes request schemas + a `parseJsonBody` helper; `/api/onboarding` and `/api/push/register` migrated off hand-rolled type guards. Added Sentry server-side (`@sentry/nextjs ^10.53.1`) via `instrumentation.ts` — no-op when `SENTRY_DSN` is unset so dev keeps working without an account. Mobile Sentry deferred to Week 3 Day 1 to batch its native module install with the audio stack rebuild. `b80ab65` is the pre-Week-3 prep commit; deploy with `scripts/deploy.sh` on the VPS to pick it up.

### Week 3 readiness audit (2026-05-19)

Code state is green: 24 commits, 2749 hand-written LOC, mobile + backend typecheck clean, `next build` clean. Disk at ~9.6 GB free, enough for one more native rebuild plus margin. VPS healthy. The four routes (`/api/health`, `/api/me`, `/api/onboarding`, `/api/push/register`) all build and the backend has zod validation, Sentry instrumentation, and uniform error shapes including PostgREST hint/details.

**Stack decisions for the voice feature (subject to verification in Week 3 Day 1):**

- **Voice provider:** Gemini Live API. Most likely model name in May 2026 is `gemini-2.5-flash-native-audio` or a 2.6 successor; the "native audio" variant gives better prosody/interruptions, the "half-cascade" variant is ~3-5× cheaper. Confirm in `ai.google.dev/gemini-api/docs/live` and `cloud.google.com/vertex-ai/generative-ai/docs/live-api` before coding.
- **Transport:** WebSocket directly from mobile to Google, with the ephemeral token minted by our backend (`authTokens.create` per the 2025 spec — name to confirm). Our nginx + Docker stack stays out of the audio path; only HTTP for the ephemeral handshake. No nginx WS config changes needed.
- **Audio formats:** input PCM 16-bit mono 16 kHz, output PCM 16-bit mono 24 kHz, base64-wrapped in WS JSON. (High confidence — these have been stable across Gemini Live revisions.)
- **EU region:** **bloqueante** — must verify Gemini Live is available in `europe-southwest1` (Madrid) or at least `europe-west1`/`europe-west4`. If only US, we accept a higher latency budget or proxy via our own GCP region — to be decided after measurement.
- **Audio stack on mobile:** `expo-av` is **not enough** for this case (file-based, no chunk callbacks at capture, no PCM buffer streaming at playback). Day 1 spike with `@siteed/expo-audio-stream` (exact match: chunk callbacks + Int16Array playback) is the fast path. `react-native-audio-api` (Software Mansion) is the more conservative bet long-term. The maintainer-of-one risk on `@siteed/expo-audio-stream` is acknowledged — we verify recent releases in 2026 before committing.
- **iOS audio session:** `PlayAndRecord` category, `voiceChat` mode (delegates AEC to iOS — essential to avoid feedback), options `defaultToSpeaker | allowBluetooth | allowBluetoothA2DP`. Interruption + route-change listeners needed for headphones plug/unplug and incoming calls.
- **Server-side hard caps:** free tier `5 min/day`, premium `90 min/day` soft warning + `120 min/day` hard cap, per-session max `12 min`. Watchdog timer client-side. Heartbeat every 30 s. Backend rejects with 402 (paywall) or 429 (cap) accordingly. Per-event row in `voice_usage_logs` with cost estimate.

**Tentative Week 3 timeline (5 working days):**

Day 1 — Setup + spike. Verify Gemini Live model name/EU region/ephemeral token endpoint in official docs. Install audio stack + mobile Sentry. Single native rebuild. Backend `POST /api/realtime/session` minting an ephemeral. Mobile WS hello-world. Measure Madrid → endpoint latency.

Day 2 — `VoiceSession` abstraction in `mobile/src/services/voice/` so a future Pipecat migration touches one provider class. `useVoiceSession` hook. Minimal `(app)/session.tsx`.

Day 3 — Hard caps + cost tracking server-side. Watchdog + heartbeat. `voice_usage_logs` writes.

Day 4 — UX of session screen (orb, live transcript, end button). End-of-session feedback call.

Day 5 — Reconnect logic on WS drop. iOS audio session interruption handling. Tests for streak calc, minute accounting, subscription state. Demo: 5-min session with live transcript + interrupted-by-call recovery.

- 2026-05-19 → 2026-05-20 (Week 3 Day 1): **Voice loop end-to-end working in production.** A mobile client can POST /api/realtime/session, get back a sessionId + WS URL, open WS to wss://api.converflow.tech/voice with Bearer.<clerk_jwt> subprotocol, and the voice-gateway authenticates, looks up the session in Supabase, opens upstream WS to Google Gemini Live, and proxies the bidi audio stream. Latency from Madrid laptop: handshake median 137ms, TTFA median 2356ms (text-prompt path includes ~2s of TTS warmup; real audio-input path should hit the brief's <800ms target — to be measured in Day 2 from the mobile app). 11 commits land plus a handful of in-flight fixes. Decisions and gotchas worth remembering:
  1. **Live API model is `gemini-2.5-flash-native-audio-latest` on `v1beta`, NOT `gemini-3.5-flash`.** Initial research said `gemini-3.5-flash` was GA for Live API — verified false by listing `/v1beta/models?key=…`: 3.5-flash supports only `generateContent`, not `bidiGenerateContent`. The Live-capable models are the `gemini-2.5-flash-native-audio-*` family and `gemini-3.1-flash-live-preview`. Endpoint URL must be `v1beta` (`v1alpha` works but exposes pre-release surface).
  2. **Architecture is backend-proxy (Option B).** Mobile opens WS to our voice-gateway, gateway opens upstream WS to Google with the static API key. Mobile never sees Google credentials. The Clerk JWT travels via the `Sec-WebSocket-Protocol: Bearer.<jwt>` subprotocol (React Native WebSocket can set subprotocols but not arbitrary headers). Hard caps and cost tracking become enforceable server-side; Pipecat migration in Mes 3-4 only swaps the upstream connection inside voice-gateway, not the mobile pipeline.
  3. **Audio over the wire is protobuf binary**, not JSON-with-base64. Setup ACK is a 26-byte binary frame, first audio chunk is ~60 KB binary, then a stream of ~2.8 KB binary frames. The voice-gateway forwards them verbatim; the client decodes PCM and plays. Latency-measurement scripts had to be updated for binary frames.
  4. **voice-gateway runs in a separate Docker service** (`voice-gateway/` directory), Node 22 + `ws` + `@clerk/backend` + `@supabase/supabase-js` + `pino`. Shares `backend/.env.local` via `env_file:` in compose; PORT is overridden to 8083 via compose `environment:` because the shared env_file carries PORT=3000 for the Next.js backend.
  5. **Bugs caught and fixed during deploy:**
     - `voice-gateway` container restart-looped on first deploy because `GEMINI_API_KEY` was missing from `/opt/converflow/backend/.env.local`. zod env validation correctly refused to boot; operator had to add the key + recreate.
     - `voice-gateway` listened on container port 3000 instead of 8083 because of PORT collision with backend in the shared env_file. Fixed by adding `environment: { PORT: 8083 }` override in compose.
     - The nginx vhost copy-over erased certbot's :443 block, returning a hostname-mismatched `converflow.ai` cert on `api.converflow.tech` requests. Recovered with `certbot --nginx --reinstall`. Template now includes both :80 and :443 blocks with stable cert paths so future copy-overs preserve SSL.
     - The deployed nginx vhost lacked the `/voice` location (template change had never been copied), so WS upgrades silently routed to the Next.js backend and hung.
  6. **Cost economics confirmed reasonable.** Public Gemini pricing at `gemini-3.5-flash` tier (which is also the price tier for 2.5-flash-native-audio): $0.25/M input audio tokens, $0.75/M output. At ~32 tokens/sec, a 10-min session is ~$0.01. Premium €9.99/mo with 30 sessions/mo → $0.30 IA cost → ~97% gross margin. Free tier 5 min/day → ~$0.15/user/mo subsidy. Context caching reduces another 30-40%.
  7. **The TTFA target needs revisiting.** Brief says <800ms TTFA. Text-prompt path measured 2.4s but includes TTS warmup. Real audio-input path is theoretically faster (model stays in audio domain end-to-end). Day 2 measurement from the mobile app with real PCM input will tell us if 800ms is achievable on Gemini Live from Madrid or if we need to negotiate the number down/move to Pipecat sooner.
- 2026-05-25 (Week 3 Day 2): **Mobile audio scaffolded + voice session UI live in dev build, BUT WebSocket to voice-gateway is BLOCKED by an iOS-Simulator-specific issue.** Three commits land before the block: install `@siteed/expo-audio-stream@1.16.0` + `expo-av` and rebuild the dev client (later versions of audio-stream require Expo >=52, the renamed `@siteed/audio-studio` is the canonical package going forward); voice services scaffold (`mobile/src/services/voice/{realtimeClient,audioCapture,audioSession}.ts`); `useVoiceSession` hook + `(app)/session.tsx` screen + Home entry button. Three follow-on commits chase the WS bug: `069d4ed` fixes an /api/me infinite loop (getToken in useEffect deps + Clerk recreates the function each render — 843 calls in <2min before the fix) and adds AbortController+timeout to `src/lib/api.ts`; `9e5b615` switches the WS auth from `Sec-WebSocket-Protocol: Bearer.<jwt>` to `?token=<jwt>` query param because RN's iOS WebSocket has buggy subprotocol negotiation; `73e8481` disables HTTP/2 on the api.converflow.tech nginx vhost because RN WebSocket negotiated h2 via ALPN and nginx 1.27 doesn't bridge HTTP/2 Extended CONNECT (RFC 8441) → HTTP/1.1 backend Upgrade cleanly.

  **State at end of day:** none of those fixes solved the actual block. The mobile app calls `new WebSocket(wss://api.converflow.tech/voice?...&token=...)`, sees `[ws] connecting`, and the close handler fires immediately with `code=0 reason=""`. The voice-gateway sees ZERO incoming connections (logs are empty for new attempts). nginx access logs show ZERO /voice hits from the mobile user-agent `Converflow/1 CFNetwork/3860.600.12 Darwin/25.4.0` — only the curl probes we ran for diagnosis. iOS-Sim system logs (`xcrun simctl spawn booted log stream --predicate 'process == "Converflow"'`) show successful TLS 1.3 handshakes to `api.converflow.tech:443` for `/api/me` (ALPN http/1.1, cert trust OK), Clerk, Metro, etc. — but ZERO WebSocket-related events anywhere. The WebSocket attempt never reaches CFNetwork at all.

  **Working hypothesis:** RN 0.74.5 still uses SocketRocket (RCTSRWebSocket) for the JS `WebSocket` global instead of `NSURLSessionWebSocketTask`. SocketRocket has known issues with modern TLS/iOS combos and is being phased out (RN 0.75+ defaults to URLSession). On iOS 26.5 Simulator the combination silently fails before producing any system-level network call. This isn't our code — backend + nginx + gateway all proved to handle WS upgrades correctly via curl from the same Mac.

  **What's NOT the bug** (eliminated empirically):
  - nginx routing: curl with WS Upgrade headers gets HTTP 401 from gateway → routing works.
  - voice-gateway code: latency spike from Node `ws` (scripts/measure-voice-latency.mjs) successfully opens WS, gets `client connected, opening upstream` logs, completes Google upstream setup, streams 60+ binary frames back. Proven on 2026-05-20.
  - HTTP/2 mismatch: disabled `http2 on;` on the vhost, confirmed `curl --http2 https://...` now returns `HTTP/1.1`. WS still fails the same way.
  - JWT/auth shape: tried Bearer.<jwt> subprotocol, then ?token=<jwt>, then a fallback that accepts both — same close code 0 on the client side.
  - Backend deploy state: gateway logs confirmed the latest commit is running (`handleProtocols` was active in the rebuilt image).
  - Mobile bundle freshness: Metro served 16+ bundles after the relevant code changes; `[ws] connecting … (auth via ?token=)` appears in logs, confirming the new client code is loaded.

  **Day-3 plan (in order of preference):**
  1. **Write a minimal repro outside our app** — a 30-line Expo SDK 51 project that just does `new WebSocket('wss://api.converflow.tech/voice?sessionId=test&token=fake')` and logs the events. If the close-code-0 reproduces, it's confirmed an RN+iOS Sim bug → file the issue, then try option 2. If it works in the repro, something in our app is interfering (maybe a Reanimated/NativeWind/other native module sabotaging SocketRocket) → bisect.
  2. **Try Expo SDK 53 or 54 upgrade.** Likely uses `NSURLSessionWebSocketTask` by default. 2-4h work, risk of cascading dep breaks (we pinned NativeWind 4.1.x to dodge Reanimated 4, that pin would need re-evaluation under SDK 53+).
  3. **Test on a real iPhone.** Requires Apple Developer Program ($99) + provisioning + dev build for device. Was Week-9 scope, would be pulled forward. If WS works on device but not Sim, confirms Sim bug and we keep developing on device until SDK upgrade is feasible.
  4. **Worst case: write an HTTP-polling shim** for the Day-2 spike to get a TTFA number on the wire. Awful UX but proves the rest of the stack and unblocks downstream work while we figure out the real WS path. Don't ship this — replace it with proper WS before TestFlight.

  Diagnostics that are useful to keep: `[ws] connecting`, `[voice] step N done`, `[api] ← METHOD path → HTTP status in Xms` logs are still in the code — they earn their keep until we ship.
- 2026-05-25 (Week 3 Day 3 — bug location confirmed): **Minimal repro proved the bug is RN 0.74.5 / SDK 51 + iOS 26.5 Sim, not our app.** Built a 30-line Expo SDK 56 project (`/tmp/ws-repro`, now deleted), ran the exact same `new WebSocket('wss://api.converflow.tech/voice?sessionId=test&token=fake')` against the same iOS 26.5 Sim through Expo Go. Result was clean:

  ```
  [ws-repro:info]  connecting → wss://api.converflow.tech/voice?...&token=fake
  [ws-repro:error] +397ms unknown
  [ws-repro:close] +398ms code=1006 reason="Received bad response code from server: 401." wasClean=false
  ```

  WS reaches the server in ~400ms, server returns HTTP 401 on the fake token (as designed), and RN reports a real close code + a real reason. Compare to our SDK-51 app where the same connection closes with `code=0 reason=""` and never touches CFNetwork at all. **The bug is in the SDK 51 SocketRocket-based WebSocket implementation on iOS 26.5 Sim.** SDK 56's NSURLSessionWebSocketTask-based implementation works.

  **Decision: upgrade Converflow mobile from SDK 51 → SDK 56.** Risk surface:
  - `nativewind@4.1.23` pinned to dodge `react-native-worklets/plugin` (which required Reanimated 4). With SDK 56 carrying Reanimated 4 by default, the pin can be lifted to NativeWind 4.2.x.
  - `@siteed/expo-audio-stream@1.16.0` was the legacy-named install we used because newer audio-studio required Expo >=52. Now we can migrate to the canonical `@siteed/audio-studio@3.x`.
  - `@clerk/clerk-expo@2` → may need to bump for RN 0.85 compat.
  - `expo-router@~3.5`, `expo-notifications@~0.28`, `expo-secure-store@~13`, `@react-native-community/datetimepicker@8.0.1`, `expo-web-browser@~13`, `expo-auth-session@~5.5`, `expo-av@~14` → all need SDK 56 versions.
  - `eas.json` development profile may need an update.
  - The native rebuild will take ~10-30 min and ~3-5 GB. Free disk before starting (delete `mobile/ios/`, `mobile/node_modules/`, Xcode `DerivedData/` for this project).

  Steps: bump SDK version in `mobile/package.json` + run `npx expo install --check` to align all expo-* deps; for non-expo packages do one-by-one compat verification; delete `ios/` and let prebuild regenerate; clear pods cache; `npx expo run:ios`; iterate on runtime errors; remove the SDK-51 hacks (NativeWind pin, audio-stream legacy package) as their reasons disappear.

  Once the upgrade is in, the WS work that was blocked on Day 2 should just work — `useVoiceSession.start()` will get to `step 3 done` and beyond, the voice-gateway will start seeing connections from the mobile, and we can finally measure real-audio TTFA from the sim.
- 2026-05-25 (Day 3 closed): **SDK 56 upgrade landed and voice WS now opens end-to-end from the mobile app.** Two commits: `8692bf0` (Expo 51→56, RN 0.74→0.85, React 18→19, Reanimated 3→4, NativeWind 4.1→4.2 unpinned, @siteed/expo-audio-stream@1.16 → @siteed/audio-studio@3.2, expo-av removed, expo-audio added, expo-notifications `allowAnnouncements` dropped) and `74504de` (voice session UI rewritten with inline styles, useAudioRecorder removed, diagnostic buttons removed). Also bumped local Node to 26 via brew (SDK 56's CLI requires `node:util.parseEnv` from Node ≥20.19).

  **Root cause of the Day-2 WebSocket bug, definitively identified:** `@siteed/audio-studio`'s `useAudioRecorder()` hook installs an iOS recording-interruption listener at mount that breaks `NSURLSessionWebSocketTask`. We proved this with three diagnostic buttons (raw WS to fake URL → 1006 + reason "401", real-auth WS without the hook → open + clean 1000 close, full voice flow with the hook → code=0 silent failure). Removing the hook fixed the WS instantly. **Not a platform bug, not in our infra, not Clerk JWT length, not subprotocols, not HTTP/2 — strictly an interaction between audio-studio's native interrupt listener and iOS NSURLSession on SDK 56 + iOS 26.5 Sim.**

  **What works as of end-of-Day-3:**
  - POST /api/realtime/session → returns sessionId + wsUrl in ~250ms.
  - WS opens against `wss://api.converflow.tech/voice?sessionId=…&token=<clerk_jwt>` (~350-400ms).
  - voice-gateway authenticates the JWT, looks up the session in Supabase, opens upstream WS to Google Gemini Live, sends the setup message with the system prompt, response_modalities, and transcription toggles.
  - Google's `setup_complete` ack lands at the mobile through the proxy (visible as `chunksReceived: 1` ticking in the session screen metrics).
  - iOS audio session configured for `PlayAndRecord` + `VoiceChat` via expo-audio's `setAudioModeAsync`.
  - Lifecycle clean: session row marked completed with real duration when the WS closes.

  **What's parked, in priority order for Day 4:**
  1. **Mic capture replacement.** Swap `@siteed/audio-studio`'s useAudioRecorder for expo-audio's recorder API (we already have expo-audio installed). Validate that expo-audio's hook does NOT install the same iOS interrupt listener that breaks WS. If it does, the next options are: a custom Expo module via expo-modules-api, `react-native-audio-api` from Software Mansion now that we have Reanimated 4 + worklets installed, or a native CMakeLists shim around AVAudioRecorder that explicitly does NOT register interruption observers.
  2. **Audio playback of Google's responses.** Frames come over as protobuf binary on `v1beta`. Decode in the voice-gateway (Node `protobufjs` + the `BidiGenerateContentServerMessage` schema from the Google AI Studio docs), extract the PCM bytes from `serverContent.modelTurn.parts[*].inlineData.data`, and forward just the raw PCM to the mobile client as binary WS frames. Mobile plays them via expo-audio's `AudioPlayer` with a buffer-feeding pattern (or react-native-audio-api once we adopt it).
  3. **NativeWind text styling on SDK 56.** Buttons with `bg-*` classes render fine but `text-*` and layout classes (flex-1, justify-between) are not being applied. Probably needs a babel preset adjustment for the new react-native-css-interop + Reanimated 4 + worklets stack. Cosmetic for now — `(app)/session.tsx` uses inline StyleSheet and works fine; the rest of the app (auth, onboarding, home) still uses NativeWind and will be invisible-text until this is fixed. Triage at start of Day 4 before touching more screens.
  4. **Real TTFA measurement with audio input.** Blocked on (1). Target from the brief is <800ms; text-prompt path measured 2.4s including TTS warmup, real audio path should be faster. Need a real number before we lock product UX.

  **Diagnostics still in the code** (kept on purpose for Day 4 debugging — they're cheap and useful):
  - `[voice] step N` logs in `useVoiceSession.ts` — let you trace exactly where a start attempt hangs/fails.
  - `[ws] connecting / open / closed / error` logs in `realtimeClient.ts`.
  - `[api] → METHOD path` + `[api] ← METHOD path → HTTP status in Xms` timing in `src/lib/api.ts`.
  - 15-second AbortController timeout on all api() calls; 12-second timeout on WS open.
  These also caught the /api/me infinite-loop bug from Day 2 (843 calls in <2min) where getToken was in a useEffect dep array.

  **Things to remember for next session:**
  - Prefix npm/npx with `PATH=/opt/homebrew/bin:$PATH` so SDK 56's CLI (Node ≥20.19 required) picks up Node 26 from brew instead of the system's Node 20.11.
  - The voice-gateway on the VPS is current as of `9e5b615` (token query-param + handleProtocols fallback). Nothing about the SDK upgrade needs a backend redeploy unless we change the audio frame format.
  - Disk space gets very tight during rebuilds — keep an eye on `df -h /System/Volumes/Data`. `~/.cache` carries 4-5 GB of HuggingFace models from another project; do NOT delete. Safe to nuke: `mobile/ios/`, `mobile/node_modules/`, `~/Library/Developer/Xcode/DerivedData/`, `~/.npm` cache.
  - Two diagnostic scripts in `scripts/` paid for themselves and stay: `probe-gemini-models.mjs` (list Live-capable models for an API key) and `probe-gemini-direct.mjs` (raw WS to Google bypassing our gateway).
  - Local Metro start: `cd mobile && PATH=/opt/homebrew/bin:$PATH npx expo start --dev-client`. iOS app icon name: "Converflow". Bundle id: `ai.converflow.app`. Already installed in the booted iPhone 17 Pro / iOS 26.5 simulator from the SDK-56 rebuild.
- 2026-05-25 (Day 4 closed): **Full round-trip mic → voice-gateway → Gemini Live → client verified, with live transcripts on screen.** Three iterations landed in one session: (A) mic capture via expo-audio's `useAudioStream` in a conditionally-mounted `MicCapture` child (mounts only when `phase==="live"` so its native side effects can't sabotage the WS handshake, the way `@siteed/audio-studio`'s `useAudioRecorder` did on Day 2); (B) native rebuild + simulator test showed mic streaming 16 kHz PCM into the gateway with 940 KB sent in 30s; (C) instrumented the inbound binary frames and confirmed the wire format.

  **Gemini Live wire format — DEFINITIVELY identified:** Google's v1beta `BidiGenerateContent` endpoint sends responses as **JSON encoded with the WebSocket BINARY opcode**, NOT protobuf. We dumped frames 1-3 of a live session and got verbatim JSON ASCII: `{"setupComplete":{}}`, `{"serverContent":{"inputTranscription":{"text":"<noise>"}}}`, `{"serverContent":{"interrupted":true}}`. This means the gateway needs ZERO parsing — it stays as a pure byte forwarder — and the client just does `new TextDecoder("utf-8").decode(buf) → JSON.parse → typed dispatch`. Killed the "decode protobuf in gateway" task that was sitting in the Day-3 punch list as task #2.

  **What works as of end-of-Day-4:**
  - Everything from Day-3 still works.
  - Mic capture: 16 kHz PCM int16 mono via expo-audio's `useAudioStream`, ~2720 B per onBuffer tick (~85 ms of audio), wrapped in `React.memo` + `useMemo` so parent metric ticks don't tear down the native stream. The native `useReleasingSharedObject`-vs-our-cleanup race produces a silent "[mic] capture stopped (native object already released)" line, harmless — the swift `deinit` calls `stop()` either way.
  - `realtimeClient.ts` now exposes a typed `onServerMessage(msg: GeminiServerMessage)` callback alongside the raw `onBinary`. Schema covers `setupComplete`, `serverContent.{ inputTranscription, outputTranscription, modelTurn.parts[].inlineData, turnComplete, interrupted, generationComplete }`, `usageMetadata`, `toolCall`. Parser is best-effort: JSON parse failures fall through to `onBinary` only, no exceptions thrown.
  - `useVoiceSession` accumulates `inputTranscription.text` deltas → `transcripts.user`, `outputTranscription.text` → `transcripts.model`, both reset on `start()`. TTFA measurement was rewired: now fires on the first frame containing a `modelTurn.parts[*].inlineData` (real model audio) instead of the broken byte-count heuristic that mis-fired on `<noise>` frames.
  - `(app)/session.tsx` renders a transcripts box ("Tú" / "Coach") below the metrics — placeholder text while idle, "Escuchando…" / "Esperando turno…" while live, real text once Gemini speaks.

  **Why TTFA still reads "—" in the simulator:** iOS Simulator has no real microphone input — it captures silence/system audio. Gemini's input-transcription consistently fires with `text: "<noise>"`, the VAD never detects a real turn, the model has nothing to respond to, so `modelTurn.parts[*].inlineData` never arrives. The infrastructure is ready; we just can't trigger it from a simulator. **Next session must validate on a real iPhone** (cable install via `npx expo run:ios --device`).

  **What's parked, in priority order for Day 5:**
  1. **Real-device test (iPhone + cable).** First time we use a real microphone. Expected behavior: `inputTranscription.text` contains your actual English words, `outputTranscription.text` shows Gemini's reply text, `modelTurn.parts[*].inlineData` arrives with base64 PCM, `chunksReceived` jumps past ~50 KB, TTFA populates. Provisioning prerequisite: Apple ID in Xcode → Signing & Capabilities. Bundle id `ai.converflow.app` may conflict with the simulator install on real device — switch to `ai.converflow.app.dev` if signing complains.
  2. **Audio playback.** Decode base64 PCM 24 kHz int16 mono from `inlineData.data` and play. Two paths: (a) buffer-per-turn → write a minimal WAV header → `expo-audio`'s `AudioPlayer.replace(uri)` with a temp file; (b) `react-native-audio-api` (Software Mansion) for true streaming. Start with (a) — simpler, higher latency but functional. Move to (b) when latency matters for production UX.
  3. **NativeWind text styling on SDK 56.** Same as Day-3 punch list. Still parked, still cosmetic — session screen uses inline styles and works.
  4. **Audio session split.** Currently `configureForVoiceSession()` sets `PlayAndRecord` + `voiceChat` mode via expo-audio's `setAudioModeAsync`, but expo-audio's `AudioStream.start()` then overrides with `.record` + `.measurement`. Doesn't break anything today (record-only works fine) but kills the `voiceChat` mode's native AEC. When audio playback lands, we'll need to bypass expo-audio's session override — either patch the library, contribute upstream, or write a small Expo module that wraps `AVAudioEngine` with the right session.

  **Diagnostics still in code, kept on purpose:**
  - First 3 binary frames are dumped as `[ws] bin frame #N XB / ascii / hex(64)` — canary against Google ever switching wire format. Cheap: 3 calls per session.
  - `[voice] setupComplete from upstream`, `[voice] TTFA: X ms (first model audio chunk, YB)`, `[voice] turnComplete (model audio total this turn: XB)`, `[voice] interrupted (user started speaking)` — turn-level visibility for debugging conversation flow on real device.

  **Things to remember for next session:**
  - When testing on a real device, the dev client must be built FOR that device's architecture. `npx expo run:ios --device` will rebuild against the connected iPhone. Allow ~5-8 min.
  - Free-tier Apple Developer accounts can sideload but the app expires after 7 days. Paid account ($99/yr) for longer-lived installs or TestFlight.
  - The `MicCapture` component is the canary for the Day-2 useAudioRecorder bug. If at any point we need to mount an audio hook at the top of useVoiceSession (e.g., to do mic level metering for a UI orb), test WS opens first — the failure mode is fast and obvious.
- 2026-05-25 (Day 4 — late evening audit + hallucination fix): User reported the model was inventing user statements during conversation (e.g., responding with "Sounds like you were busy!" when user only said "Hi"). Ran a parallel three-agent audit (mobile / backend / gateway). Root cause of the hallucination identified in the gateway's Gemini setup message:
  1. `generation_config.temperature` was unset → default ~1.0 → high creativity, low fidelity to actual input.
  2. `realtime_input_config.automatic_activity_detection` was `{}` (defaults) → over-triggered, cutting model turns mid-sentence, training the model to "wing it".
  3. `DAY1_SYSTEM_INSTRUCTION` literally said *"If the student goes silent for a few seconds, ask a short follow-up question to keep the conversation alive"* → encoded the gap-filling behaviour as a feature, not a bug.

  Combined fix landed in `voice-gateway/src/upstream.ts`:
  - `temperature: 0.6`, `top_p: 0.85`, `candidate_count: 1`, `media_resolution: "MEDIA_RESOLUTION_LOW"`
  - `automatic_activity_detection` tuned: `start_of_speech_sensitivity: "START_SENSITIVITY_LOW"`, `end_of_speech_sensitivity: "END_SENSITIVITY_LOW"`, `prefix_padding_ms: 200`, `silence_duration_ms: 1200`
  - `activity_handling: "NO_INTERRUPTION"`, `turn_coverage: "TURN_INCLUDES_ONLY_ACTIVITY"`
  - `proactivity: { proactive_audio: false }`, `enable_affective_dialog: false`
  - System prompt rewritten to forbid guessing: "If the student's audio is unclear, garbled, partial, or you are not confident what they said, ask them to repeat: 'Sorry, could you say that again?' Do not guess. If there is silence, stay quiet. Do not fill gaps with follow-ups."

  Other fixes in the same wave:
  - `backend/app/api/realtime/session/route.ts`: cap is now env-driven via `FREE_TIER_DAILY_LIMIT_SECONDS` + `MAX_SESSION_DURATION_SECONDS`. Defaults unchanged (300s / 720s). Set `FREE_TIER_DAILY_LIMIT_SECONDS=1800` in `/opt/converflow/backend/.env.local` for unblocked dev testing.
  - `voice-gateway/src/server.ts`: WS `close` handlers now inspect the close code. Code 1000 → `markSessionCompleted`; anything else → `markSessionAborted` with the abnormal-close reason. Analytics will stop pretending crashes were clean wins.
  - `mobile/src/services/voice/realtimeClient.ts`: Blob → ArrayBuffer promise chain now has a `.catch` that surfaces decode failures via `onError` instead of being an unhandled rejection.
  - `mobile/src/components/MicCapture.tsx`: `onChunkRef.current = onChunk` moved inside `useEffect` (was a React-Concurrent foot-gun under double-render).
  - `mobile/package.json` + `mobile/app.config.ts`: dropped `@siteed/audio-studio` dependency + plugin. Was dead weight since Day-4-A replaced it with `expo-audio`'s `useAudioStream`. Saves a few MB of native code and removes the very iOS recording-interruption listener whose existence was the Day-2/3 root cause.

  Deploy required after these commits:
  1. **Backend**: `cd /opt/converflow && git pull && docker compose up -d --build backend` (and optionally add `FREE_TIER_DAILY_LIMIT_SECONDS=1800` to `backend/.env.local` first).
  2. **Voice-gateway**: `cd /opt/converflow && git pull && docker compose up -d --build voice-gateway` (the hallucination fix lives here).
  3. **Mobile**: `npm install` (drops `@siteed/audio-studio`) then a native rebuild via `npx expo run:ios` to actually remove the unused module from the binary. Optional in dev — the dead module just sits there, harmless.

  ## Current architecture (end-of-Day-4 snapshot)

  ```
  iPhone / iOS Sim                       VPS (Hostinger Paris, root@187.77.166.246)
  +-----------------+                    +--------------------------------------+
  | Converflow.app  |                    |  host nginx (HTTP/1.1, no HTTP/2)    |
  |  (Expo SDK 56)  |   HTTPS / WSS      |    api.converflow.tech → 127.0.0.1   |
  | Clerk auth      | ─────────────────► |       :8082  Next.js backend         |
  | useVoiceSession |                    |       :8083  voice-gateway (WS)      |
  | MicCapture      | ◄───── WSS ────────│  Both run in docker compose          |
  | AudioPlayback   |                    +--------------------------------------+
  +-----------------+                                  │
                                                       │ Service-role
                                                       ▼
                                              +-----------------+
                                              |  Supabase       |
                                              |  (users,        |
                                              |   sessions, …)  |
                                              +-----------------+
                                                       │
                                                       │ HTTPS API
                                                       ▼
                                              +-----------------+
                                              |  Clerk          |
                                              |  (JWT verify)   |
                                              +-----------------+

  voice-gateway --- WSS ---► Google Gemini Live (gemini-2.5-flash-native-audio-latest, v1beta)
  ```

  **Mobile (Expo SDK 56)**
  - `(app)/session.tsx` — voice screen, inline StyleSheet (NativeWind 4.2 text bug still parked). Shows phase, metrics, "Tú/Coach" transcripts, action button. Conditionally mounts `<MicCapture>` and `<AudioPlayback>` ONLY when `phase === "live"`.
  - `hooks/useVoiceSession.ts` — orchestrator. State machine `idle → starting → live → stopping → ended` (or `error`). Owns POST to `/api/realtime/session`, opens WS via `RealtimeClient`, accumulates transcripts + per-turn audio buffer, publishes latest WAV URI for playback.
  - `services/voice/realtimeClient.ts` — typed WS client. Knows the Gemini JSON-as-binary wire format; emits `onServerMessage(GeminiServerMessage)` + raw `onBinary` + `onText`. Always passes Clerk JWT via `?token=` query param (RN/iOS subprotocol bug from Day 2-3).
  - `services/voice/audioCapture.ts` — encoding constants + base64 helper. Pure module, no React.
  - `services/voice/audioSession.ts` — wraps `expo-audio`'s `setAudioModeAsync` for `PlayAndRecord` mode. Note: expo-audio's stream overrides this to `.record + .measurement` on start — known follow-up.
  - `services/voice/audioPlayback.ts` — `base64ToBytes`, `buildWavFile` (PCM 24 kHz int16 mono → WAV), `writeTurnWavToCache`, `isLikelyMeaningfulEnglish` filter.
  - `components/MicCapture.tsx` — `useAudioStream` consumer, sends PCM chunks to parent via `onChunk` callback. Memoized.
  - `components/AudioPlayback.tsx` — `useAudioPlayer` consumer, plays per-turn WAVs as they're written. Memoized.

  **Backend (Next.js 15, App Router)**
  - `app/api/me/route.ts` — Clerk-gated GET that returns the user row from Supabase (and creates it if missing). Mobile calls on every screen mount; UPSERT-on-every-call is a known inefficiency (audit HIGH-4).
  - `app/api/onboarding/route.ts` — saves onboarding answers.
  - `app/api/push/register/route.ts` — stores Expo push tokens for daily reminders.
  - `app/api/realtime/session/route.ts` — mints a `sessions` row, enforces the daily cap (now env-driven), returns sessionId + wsUrl + maxDurationSeconds for the client to use.
  - `app/api/health/route.ts` — shallow liveness.
  - `lib/supabaseAdmin.ts` — singleton service-role Supabase client (bypasses RLS). Used by every API route since we already do per-user filtering in code.

  **voice-gateway (Node 22 + `ws` + `@clerk/backend`)**
  - `server.ts` — HTTP server with WS upgrade handler. Auth via `?token=<jwt>`, looks up the session in Supabase, opens upstream WS to Gemini, pipes both directions raw (no parsing). On either-side close, marks the session completed/aborted with observed duration.
  - `upstream.ts` — opens the Gemini Live WS, sends the `setup` message (model + generation_config + speech_config + system_instruction + realtime_input_config + transcription toggles). This is where today's hallucination fix lives.
  - `clerkAuth.ts` — JWT verification via `@clerk/backend`. Caches JWKS internally.
  - `supabase.ts` — service-role client for session row lookups + updates.
  - `env.ts` — Zod-validated env loader.
  - `Dockerfile` — Node 22-alpine, multi-stage build (build TS, run dist).

  **Infrastructure**
  - VPS at `root@187.77.166.246` (Hostinger Paris). `/opt/converflow` holds the repo + `docker-compose.yml`.
  - `docker compose` runs two services: `backend` (port 8082 → 3000 inside) and `voice-gateway` (port 8083 → 8083 inside).
  - Host nginx terminates SSL for `api.converflow.tech`, proxies `/` to backend, `/voice` (Upgrade: websocket) to gateway. **HTTP/2 explicitly disabled** on this vhost (Day-2 finding: RN iOS WebSocket + nginx HTTP/2 RFC 8441 Extended CONNECT conflict).
  - DNS via Cloudflare (proxy DISABLED for the api subdomain — was breaking WSS in Day-1).
  - SSL via Let's Encrypt + certbot, auto-renew every 60 days.

  ## Roadmap to production

  Time spent so far: 3 weeks (planning + Week 3 voice spike: Days 1-4).
  Remaining estimate to a polished TestFlight beta: **~6-8 weeks**.

  **Week 4 — Polish + iPhone validation (5 days)**
  - Day 5: iPhone cable install (Xcode signing fix). Validate full loop with real mic + real speakers. Tighten audio-session conflict (`AudioStream.start()` overriding `PlayAndRecord`).
  - Day 6: NativeWind 4.2 text-styles fix (so the rest of the app stops looking broken). Onboarding screens polish.
  - Day 7: Voice session UI redesign — replace the spike layout with the planned orb visualization, live transcripts cleaner, end-of-session feedback card.
  - Day 8: Audit fix wave 2 — race condition in cap (Postgres advisory lock), session janitor for stuck-active rows, `/api/me` caching, error-response scrubbing.
  - Day 9: Bug bash on real device. Latency tuning to hit <800ms TTFA target.

  **Week 5 — Pedagogy layer (5 days)**
  - Day 10-11: Prompts table in Supabase, prompt rotation (news / journal / challenge / tech_scenario formats). Replace hardcoded DAY1_SYSTEM_INSTRUCTION.
  - Day 12-13: End-of-session feedback generation: send the transcripts to a second Gemini call (text-only, cheaper model) to get pronunciation issues, grammar errors, fluency score, 1-3 things to work on.
  - Day 14: Feedback persistence + history screen.

  **Week 6 — Streak + retention loop (5 days)**
  - Day 15-16: Daily streak logic in Supabase + push notification scheduler (uses `expo-notifications` token already collected at onboarding).
  - Day 17-18: Home screen — today's session, streak counter, history of recent feedback cards.
  - Day 19: Onboarding A/B (5-min trial without auth? sign up after first session?).

  **Week 7 — Pricing + paywall (5 days)**
  - Day 20-21: Stripe (or Apple In-App Purchase via RevenueCat) for the premium tier. Premium = no daily cap, longer sessions (12 → 30 min), advanced feedback.
  - Day 22-23: Paywall screen, restore purchases, subscription state in Supabase.
  - Day 24: Server-side receipt validation.

  **Week 8 — Beta launch prep (5 days)**
  - Day 25: TestFlight build pipeline (EAS Build). App Store Connect setup.
  - Day 26-27: Privacy policy, terms, App Store metadata, screenshots.
  - Day 28: Internal TestFlight (10 beta users via direct invite).
  - Day 29: Iterate on beta feedback.

  **Optional Weeks 9-10 — Production polish**
  - Onboarding micro-copy A/B; analytics events to a real product (PostHog / Mixpanel); error monitoring (Sentry); usage dashboards; cost monitoring per user; support flow.

  **Confidence on the 6-8 week estimate:** ~70%. Risks:
  - Audio session juggling on real device may need an Expo module rewrite (potential 3-5 day slip).
  - Gemini Live API is still in v1beta — Google has changed wire format twice in the last 6 months, could happen again.
  - App Store review for voice-recording apps is sometimes slow (5-10 day delay first time).

  **What "production-ready" means for a Spanish-speaking developer learning English:**
  - Tap a button, talk in English to an AI tutor for 5-15 minutes.
  - Tutor speaks back in English, asks relevant follow-ups, only corrects 1-2 things per turn (not pedantic).
  - End of session: short report with what went well, what to work on (pronunciation, grammar, vocabulary).
  - Daily streak + push notification at a chosen time keeps you coming back.
  - Paywall after a few free days.
  - TestFlight beta first, App Store after 2-4 weeks of beta feedback.

  **What "production-ready" does NOT mean yet:**
  - No fine-grained per-phoneme pronunciation feedback (Gemini Live doesn't expose this directly — would need a second pass through Google Speech API or Azure Pronunciation Assessment, an extra ~2 weeks if we want it).
  - No vocabulary tracking / spaced repetition (post-launch feature).
  - No personalisation of tutor style (post-launch).

  ## Where the ROOT bug of hallucination really sat

  Three audit findings in voice-gateway were the smoking gun. The mobile + backend audits returned mostly hygiene items. The whole class of "model invents user statements" is a **prompt + sampling-config problem at the upstream layer**, not a transport or client problem. Today's commit should make the same simulator test feel noticeably more grounded. The TRUE quality win comes when we hit a real device with a real microphone (less garbled audio → fewer ambiguous turns → less need for the model to guess).

  ## Audit punch list — items NOT addressed in this commit (parked for Day-5+ waves)

  **Mobile** (from audit):
  - HIGH: `stop()` guard doesn't allow recovery mid-`starting` phase.
  - HIGH: `start()` useCallback depends on `phase` — fragile if consumers ever use it in deps.
  - MEDIUM: WAV cache files leak (no cleanup, accumulate over weeks).
  - MEDIUM: `arrayBufferToBase64` allocates a 32 KB number array per chunk — GC churn at 16 kHz.
  - MEDIUM: `lastPlayedUriRef` in AudioPlayback blocks replays on error.
  - MEDIUM: `audioSession.ts` PlayAndRecord override conflict with `expo-audio`'s session — confirmed by audit, suspected cause of silent playback on real device. Test on iPhone first; if confirmed, fix by re-asserting `setAudioModeAsync` after `stream.start()`.

  **Backend** (from audit):
  - BLOCKER: race condition in cap check (two parallel POSTs both pass the check). Fix with Postgres advisory lock or partial unique index on `(user_id) WHERE status='active'`.
  - BLOCKER: sessions stuck in `active` (gateway crash, network drop) never count toward the cap — exploitable. Fix with a janitor that marks stale active rows as aborted.
  - HIGH: `/api/me` does an UPSERT on every read — wasteful, also stomps email edits. Fix: SELECT-first, UPSERT only when missing.
  - HIGH: error responses leak Postgres internals (`message`, `code`, `hint`, `details`). Sanitize.
  - MEDIUM: cap reset uses UTC midnight, not user timezone (timezone is on the user row, just not used here).

  **voice-gateway** (from audit):
  - HIGH: no concurrent-session enforcement per user. A user can open N parallel WS on the same sessionId.
  - HIGH: `Dockerfile` uses `npm install` instead of `npm ci` — non-reproducible builds.
  - MEDIUM: no backpressure on `upstreamWs.send` — under flaky uplink, frames pile up in memory.
  - MEDIUM: setup-message send isn't acked before `open()` resolves — race if client sends audio before Gemini's `setupComplete`.
  - LOW: JWT verification doesn't pass `authorizedParties` to Clerk SDK.
  - LOW: health endpoint exposes version verbatim.

  These get attacked in the Week-4 audit-fix wave (Day 8) — none are blocking for the next iPhone test.
