# Converflow — Project context for Claude

> Live decisions and project state. Future Claude sessions read this first.
> Last updated: 2026-05-19.

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
