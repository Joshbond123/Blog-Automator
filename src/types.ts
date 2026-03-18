import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null as any;

export type Niche = 
  | 'Scary / Mysterious / True Crime'
  | 'AI Tools & Technology'
  | 'Life Hacks & Tips'
  | 'Weird Facts & Discoveries'
  | 'Viral Entertainment'
  | 'Health & Wellness Hacks';

export const NICHES: Niche[] = [
  'Scary / Mysterious / True Crime',
  'AI Tools & Technology',
  'Life Hacks & Tips',
  'Weird Facts & Discoveries',
  'Viral Entertainment',
  'Health & Wellness Hacks'
];

export interface BloggerAccount {
  id: string;
  blogger_id: string;
  name: string;
  url: string;
  niche: Niche;
  status: 'connected' | 'disconnected';
  facebook_page_id?: string;
  created_at: string;
  last_execution_status?: string;
  last_executed_at?: string;
}

export interface FacebookPage {
  id: string;
  page_id: string;
  name: string;
  access_token: string;
  status: 'valid' | 'expired' | 'invalid';
  created_at: string;
  last_execution_status?: string;
  last_executed_at?: string;
}

export interface Schedule {
  id: string;
  type: 'blog' | 'video';
  target_id: string; // blogger_account_id or facebook_page_id
  posting_time: string; // HH:mm
  active: boolean;
  created_at: string;
  last_execution_status?: string;
  last_executed_at?: string;
}

export interface Post {
  id: string;
  title: string;
  blog_name?: string;
  niche: Niche;
  published_at: string;
  platform: 'Blogger' | 'Facebook' | 'Both';
  status: 'published' | 'failed' | 'pending';
  url?: string;
}
