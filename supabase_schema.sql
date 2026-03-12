-- AI Blog Automator Database Schema

-- Users table (optional, for multi-user support)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  supabase_url TEXT,
  supabase_service_role_key TEXT,
  github_pat TEXT,
  cloudflare_account_id TEXT,
  cloudflare_api_keys TEXT,
  blogger_client_id TEXT,
  blogger_client_secret TEXT,
  blogger_refresh_token TEXT,
  elevenlabs_keys TEXT,
  lightning_url TEXT,
  catbox_hash TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Blogger Accounts table
CREATE TABLE IF NOT EXISTS blogger_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blogger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  niche TEXT NOT NULL,
  status TEXT DEFAULT 'connected',
  facebook_page_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Facebook Pages table
CREATE TABLE IF NOT EXISTS facebook_pages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  status TEXT DEFAULT 'valid',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Schedules table
CREATE TABLE IF NOT EXISTS schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL, -- 'blog' or 'video'
  target_id UUID NOT NULL,
  posting_time TEXT NOT NULL, -- HH:mm
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  blog_name TEXT,
  niche TEXT NOT NULL,
  platform TEXT NOT NULL, -- 'Blogger', 'Facebook', 'Both'
  status TEXT NOT NULL, -- 'published', 'failed', 'pending'
  url TEXT,
  published_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Topics table (for history/tracking)
CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  niche TEXT NOT NULL,
  title TEXT NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Video Jobs table
CREATE TABLE IF NOT EXISTS video_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'rendering', 'completed', 'failed'
  video_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
