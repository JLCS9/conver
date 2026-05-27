# Converflow — Handover snapshot

> One-page state of the app for the next Claude session. Read this FIRST,
> then dip into `CLAUDE.md` for full context if needed.
> Last refreshed: 2026-05-27 (end of Day 9 polish — Home + Session UI).

## What works today (demo-able)

- **Voice loop end-to-end on real iPhone (cable install via Xcode).**
  Stack: Deepgram Nova-3 STT → Gemini 2.5 Flash text → ElevenLabs Flash v2.5 TTS,
  orchestrated in `voice-gateway/src/conversation.ts`. TTFA ~500ms-1s.
  Coach speaks English, hears Spanish-accented English well.
- **Memory loop.** Every conversation turn persisted to Supabase
  (`conversation_transcripts`). On session end, `POST /api/sessions/[id]/analyze`
  extracts vocabulary, grammar corrections, and profile facts via Gemini
  Flash JSON mode, and writes to `user_vocabulary` / `user_grammar_corrections`
  / `users.user_context`. Next session's coach reads memory and adapts.
- **Grammar correction via modelling.** System prompt explicitly tells the
  coach to repeat the student's idea correctly ("I goed" → "Oh nice, you
  went…") instead of lecturing. Examples in prompt. Errors captured for
  post-session analysis.
- **Mobile UX.** `(app)/session.tsx` is a chat-bubble view (user right
  blue, coach left grey) driven by `messages: Message[]`. `(app)/profile.tsx`
  is a three-tab screen (Resumen / Vocabulario / Errores) backed by
  `/api/me/insights` + `/api/me/vocabulary` + `/api/me/grammar-corrections`.
- **Home dashboard (Day 9).** `(app)/index.tsx` now leads with a streak
  hero (🔥 + N días seguidos), a hand-rolled 7-day bar chart (today
  highlighted), three stat cards (sesión media · palabras · sesiones
  últimos 7 días), a 124-px round chat CTA in brand blue, a "My Progress"
  secondary entry to the profile screen, and a discreet grey "Cerrar
  sesión" link at the bottom. Data comes from a new
  `/api/me/activity` endpoint (streak, 7-day series, totals).
  Uses `useFocusEffect` so the chart refreshes whenever the user comes
  back from a session.
- **Session screen polish (Day 9).** Removed the "VOICE SPIKE · Día 3"
  eyebrow and all the debug metadata (phase pill, session id, TTFA).
  Now: clean top bar, full-height chat scroll that auto-scrolls to
  the latest bubble, a single status pill above the bottom CTA
  ("Te escucho — habla" / "El coach está hablando" with pulse / etc),
  and a single bottom button (mic icon when idle, stop icon when live).
  Critical audio guards untouched — `audioReady` 600 ms delay,
  `coachIsSpeaking` gating, `micEpoch` force-remount, `stopWithConfirm`
  are all preserved (see file header for the load-bearing comments).

## Known-acceptable trade-offs (don't "fix" without rethinking)

- **No barge-in.** Mic is muted at the source while coach is speaking
  (client-side half-duplex via `MicCapture.paused`). User can't interrupt
  the coach mid-sentence. Acceptable for an English-tutor turn-taking
  rhythm; would need a real AEC (Krisp/Pipecat) to restore.
- **MicCapture force-remount on every turn.** iOS silently severs
  `useAudioStream`'s native input recording when `AVAudioPlayer` takes
  the audio session for TTS playback. `stream.start()` doesn't revive
  it. Only working fix is to bump a React `key` (`micEpoch` in
  session.tsx) when playback ends, which recreates the entire native
  AudioStream object. ~200ms cost per turn. Don't remove without a
  better workaround.
- **Half-duplex padding tuning.** Currently zero pad (event-driven via
  AudioPlayback.onPlaybackEnd). Day 6 had several attempts at server-side
  timer estimation that all broke (400ms too tight, 1500ms too long). The
  client-side event approach is the only one that worked. Don't go back.
- **History capped at 10 turns** (`HISTORY_TURN_CAP` in
  conversation.ts) so token spend stays flat. Older turns drop; the
  user_context JSONB carries the long-term memory instead.

## Pricing reality check (still unresolved)

At Jose's target ($8-12/month, 15 min/day = 450 min/month) **no commercial
voice API stack is profitable per user**. Even the cheapest (Gemini Live)
loses ~$25/user/month at scale. Options (Day-5 conversation):

1. Raise price to $25-30 (Speak/ELSA range).
2. Cap usage to 5-7 min/day.
3. Freemium with strict tier gates.
4. Self-host (Whisper + open LLM + Coqui TTS on GPU) — long-term plan.

**Decision still pending.** Affects Day 9+ priorities (Stripe, paywalls).

## Outstanding / pending work

- **Backend deploy of Day 8 + Day 9 endpoints.** Mobile is calling
  `/api/me/insights` + `/api/me/vocabulary` + `/api/me/grammar-corrections`
  (Day 8) + `/api/me/activity` (Day 9 — the new Home dashboard payload:
  streak, 7-day series, totals). VPS needs to pull and rebuild. First
  action of any new session: confirm deploy with
  `ssh tu-vps "cd /opt/converflow && git log --oneline -3"` and run
  `./scripts/deploy.sh` if needed. The Home screen renders gracefully
  on a 404 (shows zeros and an error pill) so the app doesn't break
  before deploy, but the dashboard is empty until the endpoint ships.
- **Pronunciation scoring** (task #81, Day 9 stretch). Options to evaluate:
  Speechace API ($$), Azure Pronunciation Assessment, Deepgram word-level
  confidence as a proxy, or self-hosted wav2vec2. Decide vendor first.
- **Proximity sensor handling.** `react-native-incall-manager` exposes
  `setProximitySensor(true)` — wire it so the screen dims + ignores
  touches when the phone is near the face. Right now we have a confirm
  dialog on stop() as a workaround for accidental cheek taps.
- **Audit punch list** (from CLAUDE.md "Week-4 audit-fix wave"): cap-check
  race condition (advisory lock), stale-session janitor, /api/me UPSERT
  hot-path, Dockerfile npm-ci, voice-gateway concurrent-session enforcement.
  None blocking demo but all blocking V1.
- **Mobile route types.** `router.push("/(app)/profile" as any)` cast in
  `app/(app)/index.tsx` because expo-router typed routes hadn't picked up
  the new screen at typecheck time. Restart Metro / rebuild to regenerate
  types and drop the `as any`.

## Critical files (the load-bearing ones)

| File | Why it matters |
|---|---|
| `voice-gateway/src/conversation.ts` | Per-session orchestrator. Deepgram + LLM + ElevenLabs glue + transcript persistence. |
| `voice-gateway/src/llm.ts` | `buildSystemPrompt(inputs)` + grammar-correction-via-modelling instructions. Tuning the coach's behaviour happens here. |
| `voice-gateway/src/supabase.ts` | `findUserWithMemory()` + `insertTranscriptTurn()`. |
| `backend/lib/sessionAnalyzer.ts` | Post-session extraction prompt + Gemini Flash JSON-mode call. Tuning what we capture from conversations happens here. |
| `backend/app/api/sessions/[id]/analyze/route.ts` | The persistence side of the analyser: vocab UPSERT, corrections INSERT, context MERGE. |
| `mobile/src/components/MicCapture.tsx` | iOS audio-stream lifecycle + `paused` prop + force-remount via `key`. |
| `mobile/src/components/AudioPlayback.tsx` | Duration-based timer for playback start/end events. Drives the mic gate via onPlaybackStart/End callbacks. |
| `mobile/app/(app)/session.tsx` | Chat view + `coachIsSpeaking` + `micEpoch` (force-remount trigger). File header lists the four audio guards that MUST NOT regress in any UI polish. |
| `mobile/app/(app)/profile.tsx` | Memory-display UI. |
| `mobile/app/(app)/index.tsx` | Home dashboard — streak hero + 7-day bar chart (hand-rolled with Views, no SVG dep) + 3 stat cards + round chat CTA + secondary "My Progress" + discreet logout. Refetches on focus. |
| `backend/app/api/me/activity/route.ts` | Powers the Home dashboard. Computes streak in JS by walking days backwards from today; honours `users.timezone`. |

## Env vars on the VPS (`/opt/converflow/backend/.env.local`)

Both `backend` and `voice-gateway` read this file via Docker `env_file:`.
The relevant keys for Day 6+:
- `GEMINI_API_KEY` — used by both backend (post-session analyser) and
  gateway (in-conversation LLM).
- `GEMINI_MODEL` — should be `gemini-2.5-flash` (NOT the `native-audio`
  variant — that one is Live-API-only and broke us on Day 6-X).
- `DEEPGRAM_API_KEY`
- `DEEPGRAM_MODEL` — defaults to `nova-3`, no need to set unless tuning.
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID` — defaults to Rachel (`21m00Tcm4TlvDq8ikWAM`).
- `ELEVENLABS_MODEL_ID` — defaults to `eleven_flash_v2_5`.

## How to deploy

```bash
ssh tu-vps "cd /opt/converflow && ./scripts/deploy.sh"
```

The script: `git pull --ff-only origin main` → `docker compose up -d --build`
→ logs last 20 lines of each service.

## Supabase schema (current)

- `users` — pre-existing + new column `user_context JSONB DEFAULT '{}'`
- `sessions` — pre-existing
- `conversation_transcripts` (new Day 7) — id, session_id, user_id, turn_index, role, text, created_at
- `user_vocabulary` (new Day 7) — user_id, word (PK with user_id), count, level, example_sentence, first/last_used_at
- `user_grammar_corrections` (new Day 7) — id, user_id, session_id, original_text, corrected_text, error_type, explanation, created_at

## Useful SQL for sanity-checking memory loop

```sql
-- All turns in latest session, ordered
SELECT turn_index, role, text FROM conversation_transcripts
WHERE session_id = (SELECT id FROM sessions WHERE user_id = (SELECT id FROM users WHERE email='jose@csodigital.tech') ORDER BY started_at DESC LIMIT 1)
ORDER BY turn_index;

-- Top 30 vocab words for me
SELECT word, count, level, example_sentence FROM user_vocabulary
WHERE user_id = (SELECT id FROM users WHERE email='jose@csodigital.tech')
ORDER BY count DESC LIMIT 30;

-- All grammar corrections, newest first
SELECT original_text AS dijiste, corrected_text AS correcto, error_type, created_at
FROM user_grammar_corrections
WHERE user_id = (SELECT id FROM users WHERE email='jose@csodigital.tech')
ORDER BY created_at DESC;

-- My profile
SELECT email, user_context FROM users WHERE email='jose@csodigital.tech';
```
