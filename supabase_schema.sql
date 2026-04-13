-- AI Blog Automator Database Schema (Supabase / Postgres)

create extension if not exists pgcrypto;

create table if not exists settings (
  id bigint primary key default 1,
  supabase_url text,
  supabase_service_role_key text,
  supabase_access_token text,
  github_pat text,
  cloudflare_configs jsonb default '[]'::jsonb,
  blogger_client_id text,
  blogger_client_secret text,
  blogger_refresh_token text,
  unrealspeech_keys jsonb default '[]'::jsonb,
  cerebras_keys jsonb default '[]'::jsonb,
  catbox_hash text,
  ads_html text,
  ads_scripts text,
  ads_placement text default 'after',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into settings (id) values (1) on conflict (id) do nothing;

create table if not exists blogger_accounts (
  id uuid primary key default gen_random_uuid(),
  blogger_id text not null,
  name text not null,
  url text not null,
  niche text not null,
  status text default 'connected',
  facebook_page_id uuid,
  created_at timestamptz default now()
);

create table if not exists facebook_pages (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  name text not null,
  access_token text not null,
  status text default 'valid',
  created_at timestamptz default now()
);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  target_id uuid not null,
  posting_time text not null,
  active boolean default true,
  last_execution_status text,
  last_executed_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  blog_name text,
  niche text not null,
  platform text not null,
  status text not null,
  url text,
  published_at timestamptz default now()
);

create table if not exists topics (
  id uuid primary key default gen_random_uuid(),
  niche text not null,
  title text not null,
  used boolean default false,
  created_at timestamptz default now()
);

create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
  status text not null,
  topic text,
  niche text,
  video_url text,
  facebook_post_id text,
  error_message text,
  completed_at timestamptz,
  created_at timestamptz default now()
);

alter table settings add column if not exists supabase_access_token text;
alter table settings add column if not exists cloudflare_configs jsonb default '[]'::jsonb;
alter table settings add column if not exists unrealspeech_keys jsonb default '[]'::jsonb;
alter table settings add column if not exists unrealspeech_rotation_index integer default 0;
alter table settings add column if not exists cerebras_keys jsonb default '[]'::jsonb;
alter table settings add column if not exists blogger_client_id text;
alter table settings add column if not exists blogger_client_secret text;
alter table settings add column if not exists blogger_refresh_token text;
alter table settings add column if not exists ads_html text;
alter table settings add column if not exists ads_scripts text;
alter table settings add column if not exists ads_placement text default 'after';

alter table schedules add column if not exists last_execution_status text;
alter table schedules add column if not exists last_executed_at timestamptz;
