# Converflow

Daily English conversation practice with an AI voice agent. iOS first.

Private repository. Full project context lives in [`CLAUDE.md`](./CLAUDE.md).

## Layout

| Path | Purpose |
|------|---------|
| `mobile/` | Expo React Native app |
| `backend/` | Next.js 15 API, deployed to Hostinger VPS via Docker Compose + Caddy |
| `shared/` | TypeScript types and zod schemas shared between mobile and backend |
| `supabase/` | Postgres migrations and seed data (auto-applied via Supabase GitHub integration) |
| `scripts/` | Operational scripts (`setup-vps.sh`, deploy helpers) |
| `.github/` | CI/CD workflows |

## Quick links

- Production API: `https://api.converflow.ai`
- VPS: `srv1433126.hstgr.cloud` (Hostinger, Paris)
- Backend deploy: `git push origin main` → GitHub Actions
- Mobile builds: `eas build --profile production --platform ios`

## Local development

To be filled in once `mobile/` and `backend/` are scaffolded.

## Deployment

- **Backend** auto-deploys on push to `main` via `.github/workflows/deploy-backend.yml`. See [scripts/setup-vps.sh](./scripts/setup-vps.sh) for first-time VPS provisioning.
- **Mobile** builds via EAS. TestFlight for iOS beta and production.
- **Database migrations** in `supabase/migrations/` auto-apply via the Supabase GitHub integration.
