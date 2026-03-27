# AI Blog Automator

## Overview

An automated content generation and publishing system that creates blog posts and videos using AI, then publishes them to Google Blogger and Facebook. Features a React dashboard for managing accounts, schedules, and settings.

## Tech Stack

- **Frontend**: React 19, Vite 6, Tailwind CSS 4, Lucide React, Framer Motion
- **Backend**: Express (Node.js), TypeScript via `tsx`
- **Database**: Supabase (PostgreSQL)
- **AI Services**: Cerebras (text), Cloudflare Workers AI (images), ElevenLabs (voice)
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
