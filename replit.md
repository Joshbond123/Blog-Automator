# AI Blog Automator

## Overview

An automated content generation and publishing system that creates blog posts and videos using AI, then publishes them to Google Blogger and Facebook. Features a React dashboard for managing accounts, schedules, and settings.

## Tech Stack

- **Frontend**: React 19, Vite 6, Tailwind CSS 4, Lucide React, Framer Motion
- **Backend**: Express (Node.js), TypeScript via `tsx`
- **Database**: Supabase (PostgreSQL)
- **AI Services**: Cerebras (text), Cloudflare Workers AI (images), UnrealSpeech (voice)
- **Publishing**: Google Blogger API, Facebook Graph API
- **File hosting**: Catbox.moe

## Architecture

The server (`server.ts`) runs as a single Express process that:
- Serves the React SPA via Vite middleware in development
- Serves static `dist/` files in production
- Exposes REST API routes under `/api/`
- Runs a `node-cron` job every minute to trigger scheduled automations

## Project Structure

```
/
├── server.ts              # Main Express + Vite server
├── automation.ts          # AI content generation & publishing logic
├── supabase-backend.ts    # Supabase client and DB helpers
├── secrets.ts             # AES-256-GCM encryption for stored credentials
├── trigger-automation.ts  # Manual automation trigger entry point
├── supabase_schema.sql    # Database schema
├── src/
│   ├── App.tsx            # Main React dashboard
│   ├── main.tsx           # React entry point
│   └── types.ts           # Shared TypeScript types
├── automation/            # Local asset storage (source, incoming, final)
└── scripts/               # Utility scripts (e.g., image overlay rendering)
```

## Environment Variables

Required secrets (set in Replit Secrets):
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (also used as encryption key fallback)
- `SUPABASE_ACCESS_TOKEN` — Supabase access token
- `GITHUB_PAT` — GitHub personal access token

Optional:
- `APP_ENCRYPTION_KEY` — Custom AES encryption key for stored secrets
- `PORT` — Server port (default: 5000)
- `VITE_SUPABASE_URL` — Supabase URL exposed to frontend

All other API credentials (Cloudflare, Cerebras, ElevenLabs, Blogger, Facebook, etc.) are stored encrypted in the Supabase `settings` table and managed via the dashboard UI.

## Development

```bash
npm run dev    # Start server (Express + Vite middleware) on port 5000
npm run build  # Build frontend to dist/
npm run lint   # Type-check with tsc
```

## Deployment

Configured as autoscale deployment:
- **Build**: `npm run build`
- **Run**: `node --import tsx/esm server.ts` (serves built static files in production mode)

## Key Notes

- Secrets stored in Supabase are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- The cron scheduler checks for due schedules every minute and triggers blog or video automations
- Cloudflare, Cerebras, and ElevenLabs API keys are rotated across multiple configured accounts
- `upsertFileToGithub` retries on HTTP 409/422 (SHA conflicts from concurrent writes) — needed when blog and video runs sync render-pipeline files at the same time
- Hashtag system (`sanitizeHashtags` in `automation.ts`) enforces SHORT, single-word, viral tags only. Each tag ≤ 12 chars after `#`, max one internal capital, known acronyms preserved (#AI, #GPT), stopwords filtered (#The, #Behind, etc.). Used by both blog and video paths via `generateViralHashtags()` and `generateVideoScript()`. Per-niche viral tag bank in `NICHE_VIRAL_TAG_BANK`.
- Topic-duplicate handling (TopicShield) **never aborts a run** for duplicates. Both `runBlogAutomation` and `runVideoAutomation` use the unified `acquireUniqueViralTopic(supabase, niche, channel)` helper in `automation.ts` (~line 1521). The helper iterates all 100 trending candidates and silently rejects any whose raw title OR rewritten viral title collides with `topics` history (or with a previously-tried rewrite this run), logging `Duplicate topic rejected … Replacement topic requested.` for each, then logs `Unique topic selected … Generation resumed successfully` once a clean topic is found. Only real technical errors (e.g. Cloudflare/Cerebras non-429 failures, or full exhaustion of the trending feed) propagate as failures. The legacy "Post-rewrite duplicate detected … Aborting run." error path is gone.

## Git / GitHub

- Remote `origin` → https://github.com/Joshbond123/Blog-Automator (main branch)
- The Replit workspace's local `.git` is gated by the platform; pushes from this workspace are done via the GitHub Git Data API (one commit per push) using a PAT. `.replit` and `replit.nix` are excluded from those pushes.

## GitHub Actions Pipeline (CRITICAL)

The render pipeline depends on TWO GitHub Actions workflow files that MUST exist on `main`:
- `.github/workflows/title-overlay.yml` — listens for `repository_dispatch` event type `title_overlay`
- `.github/workflows/render-video.yml` — listens for `repository_dispatch` event type `render_video`

The matchers in `automation.ts` (`waitForOverlayArtifact`, `waitForVideoRenderArtifact`) require the run-name to contain the correlationId (`Title Overlay Renderer - <id>` and `Video Renderer - <id>`). If the YAML files are missing the dispatch silently has no listener and times out after 3 min with `Overlay/Video workflow run was not found.`

These files were once accidentally deleted by stale-tree pushes (commits `bd6714b`, `07b2cb9`). They were restored on 2026-04-25 with commits `476c323` (overlay) and `0878590` (video). When pushing to GitHub from any local checkout, ALWAYS verify these two files are present in your tree — never push from a checkout that lacks them or they will be removed from `main` again.
