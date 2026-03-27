import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  BookOpen, 
  Video, 
  Settings as SettingsIcon, 
  Plus, 
  Trash2, 
  ExternalLink, 
  CheckCircle2, 
  XCircle, 
  Clock,
  ChevronRight,
  Menu,
  X,
  Facebook,
  Globe,
  Zap,
  RefreshCw,
  Save,
  Database,
  Github,
  Cloud,
  Mic,
  Image as ImageIcon,
  BarChart3,
  Shield,
  Key as KeyIcon,
  Layout,
  Code,
  Check
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { supabase, NICHES, type BloggerAccount, type FacebookPage, type Schedule, type Post, type Niche } from './types';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Components ---

const Sidebar = ({ 
  activeTab, 
  setActiveTab, 
  isOpen, 
  onClose 
}: { 
  activeTab: string, 
  setActiveTab: (tab: string) => void,
  isOpen: boolean,
  onClose: () => void
}) => {
  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'blogger', label: 'Blogger Accounts', icon: BookOpen },
    { id: 'blog-scheduler', label: 'Blog Scheduler', icon: Clock },
    { id: 'video-scheduler', label: 'Video Scheduler', icon: Video },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <>
      {/* Backdrop for mobile */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[45] lg:hidden"
          />
        )}
      </AnimatePresence>

      <motion.div 
        initial={false}
        animate={{ 
          x: isOpen ? 0 : -256 
        }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className={cn(
          "w-64 bg-zinc-950 border-r border-zinc-900 h-screen flex flex-col fixed left-0 top-0 z-50 lg:translate-x-0 shadow-2xl shadow-black/50",
          !isOpen && "max-lg:-translate-x-full"
        )}
      >
        <div className="p-8 flex items-center justify-between">
          <div className="flex items-center gap-3.5 group cursor-pointer">
            <div className="w-11 h-11 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-500/20 group-hover:scale-105 transition-transform duration-300">
              <Zap className="text-white w-6 h-6 fill-white/20" />
            </div>
            <div>
              <h1 className="text-lg font-black text-white tracking-tight leading-none">BLOG</h1>
              <p className="text-[10px] font-bold text-indigo-500 tracking-[0.2em] uppercase mt-1">Automator</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="lg:hidden text-zinc-500 hover:text-white p-2"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="px-4 mb-4">
          <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
        </div>

        <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto no-scrollbar">
          <p className="px-4 text-[10px] font-bold text-zinc-600 uppercase tracking-[0.15em] mb-4 mt-2">Main Menu</p>
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setActiveTab(item.id);
                if (window.innerWidth < 1024) onClose();
              }}
              className={cn(
                "w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-300 group relative overflow-hidden",
                activeTab === item.id 
                  ? "bg-zinc-900 text-white" 
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900/50"
              )}
            >
              <div className="flex items-center gap-3.5 z-10">
                <item.icon className={cn(
                  "w-5 h-5 transition-colors duration-300", 
                  activeTab === item.id ? "text-indigo-500" : "text-zinc-600 group-hover:text-zinc-400"
                )} />
                <span className="font-semibold text-sm tracking-tight">{item.label}</span>
              </div>
              
              {activeTab === item.id && (
                <motion.div 
                  layoutId="active-pill"
                  className="absolute left-0 w-1 h-6 bg-indigo-500 rounded-r-full"
                />
              )}
              
              <ChevronRight className={cn(
                "w-4 h-4 transition-all duration-300 opacity-0 group-hover:opacity-100 group-hover:translate-x-0 -translate-x-2",
                activeTab === item.id ? "text-indigo-500/50" : "text-zinc-700"
              )} />
            </button>
          ))}
        </nav>

        <div className="p-6 mt-auto">
          <p className="text-[10px] text-zinc-600 text-center font-medium uppercase tracking-widest">
            v1.0.0 • Production
          </p>
        </div>
      </motion.div>
    </>
  );
};

const Dashboard = () => {
  const [stats, setStats] = useState({ totalPosts: 0, publishedToday: 0, activeSchedules: 0 });
  const [recentPosts, setRecentPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, postsRes] = await Promise.all([
          fetch('/api/stats').then(r => r.ok ? r.json() : {}),
          fetch('/api/recent-posts').then(r => r.ok ? r.json() : [])
        ]);
        setStats(statsRes);
        setRecentPosts(postsRes);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <div className="flex-1 p-8 flex items-center justify-center"><RefreshCw className="animate-spin text-indigo-500" /></div>;

  return (
    <div className="flex-1 p-8 space-y-8">
      <header>
        <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard Overview</h2>
        <p className="text-zinc-400 mt-1">Real-time performance metrics and recent activities.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { label: 'Total Posts', value: stats.totalPosts, icon: Globe, color: 'text-indigo-500', bg: 'bg-indigo-500/10' },
          { label: 'Published Today', value: stats.publishedToday, icon: CheckCircle2, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
          { label: 'Active Schedules', value: stats.activeSchedules, icon: Clock, color: 'text-amber-500', bg: 'bg-amber-500/10' },
        ].map((stat, i) => (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            key={stat.label} 
            className="bg-zinc-900 border border-zinc-800 p-6 rounded-3xl shadow-xl"
          >
            <div className="flex items-center justify-between mb-4">
              <div className={cn("p-3 rounded-2xl", stat.bg)}>
                <stat.icon className={cn("w-6 h-6", stat.color)} />
              </div>
            </div>
            <p className="text-zinc-400 text-sm font-medium">{stat.label}</p>
            <h3 className="text-4xl font-bold text-white mt-1">{stat.value}</h3>
          </motion.div>
        ))}
      </div>

      <section className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-xl font-bold text-white">Recent Posts</h3>
          <button className="text-indigo-400 hover:text-indigo-300 text-sm font-medium flex items-center gap-1">
            View all <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-zinc-950/50 text-zinc-500 text-xs uppercase tracking-wider">
                <th className="px-6 py-4 font-semibold">Title</th>
                <th className="px-6 py-4 font-semibold">Blog / Niche</th>
                <th className="px-6 py-4 font-semibold">Platform</th>
                <th className="px-6 py-4 font-semibold">Date</th>
                <th className="px-6 py-4 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {recentPosts.map((post) => (
                <tr key={post.id} className="hover:bg-zinc-800/30 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-white font-medium group-hover:text-indigo-400 transition-colors">{post.title}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col">
                      <span className="text-zinc-300 text-sm">{post.blog_name || 'N/A'}</span>
                      <span className="text-zinc-500 text-xs">{post.niche}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {post.platform === 'Blogger' && <Globe className="w-4 h-4 text-orange-500" />}
                      {post.platform === 'Facebook' && <Facebook className="w-4 h-4 text-blue-500" />}
                      {post.platform === 'Both' && (
                        <>
                          <Globe className="w-4 h-4 text-orange-500" />
                          <Facebook className="w-4 h-4 text-blue-500" />
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-zinc-400 text-sm">
                    {new Date(post.published_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">
                    <span className={cn(
                      "px-3 py-1 rounded-full text-xs font-semibold",
                      post.status === 'published' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                    )}>
                      {post.status}
                    </span>
                  </td>
                </tr>
              ))}
              {recentPosts.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-zinc-500 italic">
                    No posts published yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

const BloggerAccounts = () => {
  const [accounts, setAccounts] = useState<BloggerAccount[]>([]);
  const [availableAccounts, setAvailableAccounts] = useState<Array<{ blogger_id: string; name: string; url: string }>>([]);
  const [facebookPages, setFacebookPages] = useState<FacebookPage[]>([]);
  const [showConnectFbModal, setShowConnectFbModal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectTarget, setConnectTarget] = useState<{ blogger_id: string; name: string; url: string } | null>(null);
  const [selectedNiche, setSelectedNiche] = useState<Niche>(NICHES[0]);
  const [fbModalToken, setFbModalToken] = useState('');
  const [fbModalFetching, setFbModalFetching] = useState(false);
  const [fbModalPages, setFbModalPages] = useState<any[]>([]);
  const [fbModalError, setFbModalError] = useState<string | null>(null);
  const [fbModalLinking, setFbModalLinking] = useState<string | null>(null);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [refreshingAccounts, setRefreshingAccounts] = useState(false);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      const [accRes, fbRes] = await Promise.all([
        fetch('/api/blogger-accounts').then(r => r.ok ? r.json() : []),
        fetch('/api/facebook-pages').then(r => r.ok ? r.json() : []),
      ]);
      setAccounts(accRes);
      setFacebookPages(fbRes);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableAccounts = async () => {
    setRefreshingAccounts(true);
    setAvailableError(null);
    try {
      const res = await fetch('/api/blogger/available-accounts');
      if (res.ok) {
        const data = await res.json();
        setAvailableAccounts(Array.isArray(data) ? data : []);
      } else {
        const err = await res.json().catch(() => ({}));
        setAvailableError(err.error || 'Failed to fetch Blogger accounts. Please verify your OAuth credentials in Settings.');
      }
    } catch (err: any) {
      setAvailableError(err.message || 'Network error');
    } finally {
      setRefreshingAccounts(false);
    }
  };

  const connectedByBloggerId = new Set(accounts.map(a => a.blogger_id));

  const handleConnectAccount = async () => {
    if (!connectTarget) return;
    try {
      const res = await fetch('/api/blogger-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blogger_id: connectTarget.blogger_id, name: connectTarget.name, url: connectTarget.url, niche: selectedNiche, status: 'connected' })
      });
      if (res.ok) { setConnectTarget(null); await fetchData(); }
    } catch (err) { console.error(err); }
  };

  const handleDisconnect = async (account: BloggerAccount) => {
    if (!confirm(`Disconnect "${account.name}"?`)) return;
    try {
      await fetch(`/api/blogger-accounts/${account.id}`, { method: 'DELETE' });
      await fetchData();
    } catch (err) { console.error(err); }
  };

  const handleConnectFb = async (bloggerAccountId: string, facebookPageDbId: string) => {
    try {
      const res = await fetch(`/api/blogger-accounts/${bloggerAccountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facebook_page_id: facebookPageDbId })
      });
      if (res.ok) { setShowConnectFbModal(null); setFbModalPages([]); setFbModalToken(''); fetchData(); }
    } catch (err) { console.error(err); }
  };

  const handleFetchPagesFromToken = async () => {
    if (!fbModalToken.trim()) return;
    setFbModalFetching(true);
    setFbModalError(null);
    setFbModalPages([]);
    try {
      const res = await fetch('/api/facebook/pages-from-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fbModalToken.trim() })
      });
      if (res.ok) {
        const payload = await res.json();
        setFbModalPages(payload.pages || []);
        if ((payload.pages || []).length === 0) setFbModalError('No pages found for this token. Make sure you have admin access to Facebook pages.');
      } else {
        const err = await res.json().catch(() => ({}));
        setFbModalError(err.error || 'Failed to fetch pages. Check your access token.');
      }
    } catch (err: any) {
      setFbModalError(err.message || 'Network error');
    } finally {
      setFbModalFetching(false);
    }
  };

  const handleLinkFetchedPage = async (bloggerAccountId: string, page: any) => {
    setFbModalLinking(page.id);
    try {
      const existing = facebookPages.find(p => p.page_id === page.id);
      let dbId = existing?.id;
      if (!dbId) {
        const res = await fetch('/api/facebook-pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page_id: page.id, name: page.name, access_token: page.access_token || fbModalToken.trim(), status: 'valid' })
        });
        if (res.ok) { const newPage = await res.json(); dbId = newPage.id; }
      }
      if (dbId) await handleConnectFb(bloggerAccountId, dbId);
    } catch (err) { console.error(err); }
    finally { setFbModalLinking(null); }
  };

  const openFbModal = (accountId: string) => {
    setShowConnectFbModal(accountId);
    setFbModalToken('');
    setFbModalPages([]);
    setFbModalError(null);
  };

  const linkedPageName = (acc: BloggerAccount) => {
    if (!acc.facebook_page_id) return null;
    return facebookPages.find(p => p.id === acc.facebook_page_id)?.name || null;
  };

  if (loading) return (
    <div className="flex-1 flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <RefreshCw className="animate-spin text-indigo-500 w-8 h-8" />
        <p className="text-zinc-500 text-sm">Loading accounts...</p>
      </div>
    </div>
  );

  return (
    <div className="flex-1 p-4 sm:p-6 lg:p-8 space-y-6 lg:space-y-8 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Blogger Accounts</h2>
          <p className="text-zinc-400 mt-1 text-sm sm:text-base">Connect blogs and link them to Facebook pages for cross-posting.</p>
        </div>
        <button
          onClick={fetchAvailableAccounts}
          disabled={refreshingAccounts}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-60 text-sm self-start sm:self-auto"
        >
          <RefreshCw className={cn("w-4 h-4", refreshingAccounts && "animate-spin")} />
          {refreshingAccounts ? 'Fetching...' : 'Fetch Blogs'}
        </button>
      </div>

      {/* Available Blogger Accounts */}
      {(availableAccounts.length > 0 || availableError) && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-2xl sm:rounded-3xl overflow-hidden shadow-xl">
          <div className="p-4 sm:p-6 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-orange-500/10 rounded-xl flex items-center justify-center">
                <Globe className="w-4 h-4 text-orange-500" />
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white">Available Blogs</h3>
            </div>
            <span className="text-xs text-zinc-500 bg-zinc-800 px-3 py-1 rounded-full font-medium">{availableAccounts.length} found</span>
          </div>
          {availableError && (
            <div className="m-4 sm:m-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-start gap-3">
              <XCircle className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-rose-400 text-sm">{availableError}</p>
            </div>
          )}
          <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {availableAccounts.map((blog) => {
              const connected = connectedByBloggerId.has(blog.blogger_id);
              return (
                <div key={blog.blogger_id} className={cn(
                  "bg-zinc-950/60 border rounded-2xl p-4 flex items-start justify-between gap-3 transition-all",
                  connected ? "border-emerald-500/20" : "border-zinc-800 hover:border-zinc-700"
                )}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-white font-semibold text-sm truncate">{blog.name}</p>
                      {connected && <span className="flex-shrink-0 text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded-full font-bold uppercase">Connected</span>}
                    </div>
                    <p className="text-zinc-600 text-[11px] font-mono truncate">{blog.blogger_id}</p>
                    <a href={blog.url} target="_blank" rel="noreferrer" className="text-indigo-400 text-xs hover:text-indigo-300 truncate block mt-1">{blog.url}</a>
                  </div>
                  <button
                    onClick={() => { if (!connected) { setSelectedNiche(NICHES[0]); setConnectTarget(blog); } }}
                    disabled={connected}
                    className={cn(
                      "flex-shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold transition-all",
                      connected ? "bg-emerald-500/10 text-emerald-500 cursor-not-allowed" : "bg-indigo-600 text-white hover:bg-indigo-500"
                    )}
                  >
                    {connected ? <Check className="w-4 h-4" /> : 'Connect'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Welcome state when no accounts connected */}
      {accounts.length === 0 && (
        <div className="bg-zinc-900 border border-dashed border-zinc-700 rounded-2xl sm:rounded-3xl p-8 sm:p-12 flex flex-col items-center text-center gap-4">
          <div className="w-16 h-16 bg-indigo-500/10 rounded-2xl flex items-center justify-center">
            <Globe className="w-8 h-8 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-white font-bold text-lg">No Blogs Connected Yet</h3>
            <p className="text-zinc-500 text-sm mt-1 max-w-sm">Click <span className="text-indigo-400 font-semibold">Fetch Blogs</span> to load your Blogger accounts, or first add OAuth credentials in Settings.</p>
          </div>
        </div>
      )}

      {/* Connected Accounts Grid */}
      {accounts.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <h3 className="text-base sm:text-lg font-bold text-white">Connected Accounts</h3>
            <span className="text-xs text-zinc-500 bg-zinc-800 px-2.5 py-0.5 rounded-full">{accounts.length}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-6">
            {accounts.map((acc) => {
              const linked = linkedPageName(acc);
              return (
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  key={acc.id}
                  className="bg-zinc-900 border border-zinc-800 rounded-2xl sm:rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col gap-4 hover:border-zinc-700 transition-all"
                >
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="w-11 h-11 bg-orange-500/10 rounded-2xl flex items-center justify-center flex-shrink-0">
                      <Globe className="text-orange-500 w-5 h-5" />
                    </div>
                    <span className={cn(
                      "text-[10px] px-2.5 py-1 rounded-full font-bold uppercase tracking-wider flex-shrink-0",
                      acc.status === 'connected' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                    )}>{acc.status}</span>
                  </div>

                  {/* Blog Info */}
                  <div className="space-y-1 flex-1">
                    <h3 className="text-base sm:text-lg font-bold text-white leading-tight">{acc.name}</h3>
                    <p className="text-zinc-500 text-xs font-mono">ID: {acc.blogger_id}</p>
                    <a href={acc.url} target="_blank" rel="noreferrer" className="text-indigo-400 text-xs hover:text-indigo-300 break-all block">{acc.url}</a>
                    <span className="inline-block mt-1 text-xs bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded-lg font-medium">{acc.niche}</span>
                  </div>

                  {/* Facebook Status */}
                  <div className={cn(
                    "rounded-xl px-3 py-2 flex items-center gap-2",
                    linked ? "bg-blue-500/10 border border-blue-500/20" : "bg-zinc-800/50"
                  )}>
                    <Facebook className={cn("w-4 h-4 flex-shrink-0", linked ? "text-blue-400" : "text-zinc-600")} />
                    <span className={cn("text-xs font-medium truncate", linked ? "text-blue-300" : "text-zinc-500")}>
                      {linked ? linked : 'No Facebook page linked'}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2 pt-1 border-t border-zinc-800">
                    <button
                      onClick={() => openFbModal(acc.id)}
                      className="w-full py-2.5 rounded-xl bg-zinc-800 text-zinc-300 font-semibold text-sm hover:bg-zinc-700 hover:text-white transition-all flex items-center justify-center gap-2"
                    >
                      <Facebook className="w-4 h-4 text-blue-400" />
                      {linked ? 'Change Facebook Page' : 'Connect Facebook Page'}
                    </button>
                    <button
                      onClick={() => handleDisconnect(acc)}
                      className="w-full py-2.5 rounded-xl bg-rose-500/8 text-rose-400 font-semibold text-sm hover:bg-rose-500/15 transition-all"
                    >
                      Disconnect Blog
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </section>
      )}

      {/* Connect Blogger Account Modal */}
      <AnimatePresence>
        {connectTarget && (
          <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConnectTarget(null)} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <motion.div
              initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
              className="relative bg-zinc-900 border border-zinc-800 w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="sm:hidden w-10 h-1 bg-zinc-700 rounded-full mx-auto mt-3 mb-1" />
              <div className="p-5 sm:p-6 border-b border-zinc-800 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">Connect Blog</h3>
                  <p className="text-zinc-500 text-sm mt-0.5 truncate max-w-[260px]">{connectTarget.name}</p>
                </div>
                <button onClick={() => setConnectTarget(null)} className="text-zinc-500 hover:text-white p-1.5 rounded-xl hover:bg-zinc-800 transition-all"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-5 sm:p-6 space-y-5">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Content Niche</label>
                  <select
                    value={selectedNiche}
                    onChange={(e) => setSelectedNiche(e.target.value as Niche)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all appearance-none"
                  >
                    {NICHES.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <button
                  onClick={handleConnectAccount}
                  className="w-full bg-indigo-600 text-white py-3.5 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 text-sm"
                >
                  Connect Account
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Connect Facebook Page Modal */}
      <AnimatePresence>
        {showConnectFbModal && (
          <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setShowConnectFbModal(null); setFbModalPages([]); setFbModalToken(''); }} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <motion.div
              initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 40 }}
              className="relative bg-zinc-900 border border-zinc-800 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col"
            >
              <div className="sm:hidden w-10 h-1 bg-zinc-700 rounded-full mx-auto mt-3 mb-1 flex-shrink-0" />
              {/* Modal Header */}
              <div className="p-5 sm:p-6 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center">
                    <Facebook className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">Connect Facebook Page</h3>
                    <p className="text-zinc-500 text-xs mt-0.5">Enter your token to find available pages</p>
                  </div>
                </div>
                <button onClick={() => { setShowConnectFbModal(null); setFbModalPages([]); setFbModalToken(''); }} className="text-zinc-500 hover:text-white p-1.5 rounded-xl hover:bg-zinc-800 transition-all"><X className="w-5 h-5" /></button>
              </div>

              {/* Scrollable Body */}
              <div className="overflow-y-auto flex-1 p-5 sm:p-6 space-y-5">
                {/* Token Input */}
                <div className="space-y-3">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Facebook Access Token</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={fbModalToken}
                      onChange={(e) => setFbModalToken(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleFetchPagesFromToken()}
                      placeholder="Paste your User or Page access token..."
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all min-w-0"
                    />
                    <button
                      onClick={handleFetchPagesFromToken}
                      disabled={fbModalFetching || !fbModalToken.trim()}
                      className="flex-shrink-0 bg-blue-600 hover:bg-blue-500 text-white px-4 py-3 rounded-2xl font-bold text-sm transition-all disabled:opacity-50 flex items-center gap-2"
                    >
                      {fbModalFetching ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      Fetch
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-600">Get a User Access Token from <span className="text-zinc-400">developers.facebook.com/tools/explorer</span> with <span className="text-zinc-400">pages_show_list</span> permission.</p>
                </div>

                {/* Error */}
                {fbModalError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-2">
                    <XCircle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                    <p className="text-rose-400 text-sm">{fbModalError}</p>
                  </div>
                )}

                {/* Fetched Pages from Token */}
                {fbModalPages.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      <h4 className="text-sm font-bold text-emerald-400">{fbModalPages.length} Page{fbModalPages.length !== 1 ? 's' : ''} Found</h4>
                    </div>
                    <div className="space-y-2">
                      {fbModalPages.map(page => (
                        <div key={page.id} className="bg-zinc-950/80 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-3 hover:border-blue-500/40 transition-all group">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 bg-blue-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
                              <Facebook className="w-4 h-4 text-blue-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-white font-semibold text-sm truncate">{page.name}</p>
                              <p className="text-zinc-500 text-xs font-mono">ID: {page.id}</p>
                              {page.category && <p className="text-zinc-600 text-xs">{page.category}</p>}
                            </div>
                          </div>
                          <button
                            onClick={() => handleLinkFetchedPage(showConnectFbModal, page)}
                            disabled={fbModalLinking === page.id}
                            className="flex-shrink-0 bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-xl text-xs font-bold transition-all disabled:opacity-60 flex items-center gap-1.5"
                          >
                            {fbModalLinking === page.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            Link
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Saved Pages Section */}
                {facebookPages.length > 0 && (
                  <div className="space-y-3">
                    <div className="h-px bg-zinc-800" />
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Or Link a Saved Page</h4>
                    <div className="space-y-2">
                      {facebookPages.map(page => (
                        <button
                          key={page.id}
                          onClick={() => handleConnectFb(showConnectFbModal, page.id)}
                          className="w-full flex items-center justify-between p-3.5 bg-zinc-950 border border-zinc-800 rounded-2xl hover:border-indigo-500/50 transition-all group text-left"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 bg-indigo-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
                              <Facebook className="w-4 h-4 text-indigo-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-white font-medium text-sm truncate">{page.name}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <div className={cn("w-1.5 h-1.5 rounded-full", page.status === 'valid' ? 'bg-emerald-500' : 'bg-rose-500')} />
                                <span className="text-[10px] text-zinc-500 uppercase font-bold">{page.status}</span>
                              </div>
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-indigo-400 flex-shrink-0 transition-colors" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {facebookPages.length === 0 && fbModalPages.length === 0 && !fbModalFetching && !fbModalError && (
                  <div className="py-6 text-center text-zinc-500 text-sm">
                    Enter a Facebook access token above to fetch and connect your pages.
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Scheduler = ({ type }: { type: 'blog' | 'video' }) => {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [accounts, setAccounts] = useState<BloggerAccount[]>([]);
  const [fbPages, setFbPages] = useState<FacebookPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [newSchedule, setNewSchedule] = useState({ target_id: '', schedule_time: '12:00' });
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [type]);

  const fetchData = async () => {
    try {
      const [schRes, accRes, fbRes] = await Promise.all([
        fetch('/api/schedules').then(r => r.ok ? r.json() : []),
        fetch('/api/blogger-accounts').then(r => r.ok ? r.json() : []),
        fetch('/api/facebook-pages').then(r => r.ok ? r.json() : [])
      ]);
      setSchedules((schRes || []).filter((s: Schedule) => s.channel === type));
      setAccounts(accRes || []);
      setFbPages(fbRes || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: type,
          target_id: newSchedule.target_id,
          schedule_time: newSchedule.schedule_time,
          timezone: 'UTC',
          is_enabled: true,
          metadata: {}
        })
      });
      if (res.ok) {
        setShowAdd(false);
        setNewSchedule({ target_id: '', schedule_time: '12:00' });
        fetchData();
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to create schedule' }));
        setAddError(err.error || 'Failed to create schedule');
      }
    } catch (err: any) {
      console.error(err);
      setAddError(err.message || 'Network error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleEdit = async (schedule: Schedule) => {
    const schedule_time = prompt('Update daily posting time (HH:mm)', schedule.schedule_time.slice(0, 5)) || schedule.schedule_time;
    const target_id = schedule.target_id;
    try {
      const res = await fetch(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_time, target_id })
      });
      if (res.ok) fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRunNow = async (id: string) => {
    setRunningId(id);
    try {
      const res = await fetch(`/api/automation/run/${id}`, { method: 'POST' });
      if (res.ok) {
        alert('Automation triggered successfully!');
      }
    } catch (err) {
      console.error(err);
      alert('Failed to trigger automation.');
    } finally {
      setRunningId(null);
    }
  };

  if (loading) return <div className="flex-1 p-8 flex items-center justify-center"><RefreshCw className="animate-spin text-indigo-500" /></div>;

  return (
    <div className="flex-1 p-8 space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">
            {type === 'blog' ? 'Blog Post Scheduler' : 'Video Scheduler'}
          </h2>
          <p className="text-zinc-400 mt-1">
            {type === 'blog' 
              ? 'Schedule automated blog posts to your Blogger accounts.' 
              : 'Schedule automated video posts to your Facebook pages.'}
          </p>
        </div>
        <button 
          onClick={() => setShowAdd(true)}
          className="bg-indigo-600 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20"
        >
          <Plus className="w-5 h-5" /> Add Schedule
        </button>
      </header>

      <section className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-6 border-b border-zinc-800">
          <h3 className="text-xl font-bold text-white">Active Schedules</h3>
        </div>
        <div className="divide-y divide-zinc-800">
          {schedules.map((s) => {
            const target = type === 'blog' 
              ? accounts.find(a => a.id === s.target_id)
              : fbPages.find(p => p.id === s.target_id);
            
            return (
              <div key={s.id} className="p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 hover:bg-zinc-800/30 transition-colors">
                <div className="flex items-center gap-4">
                  <div className={cn(
                    "w-12 h-12 rounded-2xl flex items-center justify-center",
                    type === 'blog' ? "bg-orange-500/10 text-orange-500" : "bg-blue-500/10 text-blue-500"
                  )}>
                    {type === 'blog' ? <Globe className="w-6 h-6" /> : <Facebook className="w-6 h-6" />}
                  </div>
                  <div>
                    <h4 className="text-white font-bold">{target?.name || 'Unknown Target'}</h4>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1 text-zinc-500 text-sm">
                        <Clock className="w-3 h-3" /> {s.schedule_time?.slice(0, 5)} Daily
                      </span>
                      <span className="w-1 h-1 bg-zinc-700 rounded-full" />
                      <span className="text-indigo-400 text-xs font-bold uppercase tracking-wider">
                        {type === 'blog' ? (target as BloggerAccount)?.niche : 'Video Content'}
                      </span>
                      <span className={cn(
                        "text-xs font-semibold px-2 py-0.5 rounded-full",
                        s.is_enabled ? "bg-green-500/10 text-green-400" : "bg-zinc-700/50 text-zinc-500"
                      )}>
                        {s.is_enabled ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-600 mt-2">Created: {new Date(s.created_at).toLocaleString()}</p>
                    <p className="text-[11px] mt-1 text-zinc-500">Last Run: {s.metadata?.last_execution_status || 'Not executed yet'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleEdit(s)}
                    className="p-3 text-zinc-500 hover:text-amber-400 transition-colors"
                    title="Edit Schedule"
                  >
                    <Clock className="w-5 h-5" />
                  </button>
                  <button 
                    onClick={() => handleRunNow(s.id)}
                    disabled={runningId === s.id}
                    className="p-3 text-zinc-500 hover:text-indigo-400 transition-colors disabled:opacity-50"
                    title="Run Now"
                  >
                    <Zap className={cn("w-5 h-5", runningId === s.id && "animate-pulse text-indigo-500")} />
                  </button>
                  <button onClick={() => handleDelete(s.id)} className="p-3 text-zinc-500 hover:text-rose-500 transition-colors">
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
            );
          })}
          {schedules.length === 0 && (
            <div className="p-12 text-center text-zinc-500 italic">
              No schedules created yet.
            </div>
          )}
        </div>
      </section>


      {/* Add Schedule Modal */}
      <AnimatePresence>
        {showAdd && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowAdd(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
                <h3 className="text-xl font-bold text-white">Add {type === 'blog' ? 'Blog' : 'Video'} Schedule</h3>
                <button onClick={() => setShowAdd(false)} className="text-zinc-500 hover:text-white">
                  <X className="w-6 h-6" />
                </button>
              </div>
              <form onSubmit={handleAdd} className="p-6 space-y-6">
                {addError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
                    {addError}
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-400">Select {type === 'blog' ? 'Blogger Account' : 'Facebook Page'}</label>
                  <select 
                    required
                    value={newSchedule.target_id}
                    onChange={(e) => setNewSchedule({ ...newSchedule, target_id: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-colors appearance-none"
                  >
                    <option value="">Select target...</option>
                    {type === 'blog' 
                      ? accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.niche})</option>)
                      : fbPages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                    }
                  </select>
                  {type === 'blog' && accounts.length === 0 && (
                    <p className="text-xs text-amber-400 mt-1">No Blogger accounts configured. Add one first.</p>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-zinc-400">Daily Posting Time (UTC)</label>
                  <input 
                    required
                    type="time" 
                    value={newSchedule.schedule_time}
                    onChange={(e) => setNewSchedule({ ...newSchedule, schedule_time: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <button 
                  type="submit"
                  className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20"
                >
                  Create Schedule
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Settings = () => {
  const [settings, setSettings] = useState<any>({
    cloudflare_configs: [],
    elevenlabs_keys: [],
    cerebras_keys: [],
    ads_placement: 'after',
    cloudflare_image_model: '@cf/leonardo/phoenix-1.0'
  });
  const [fbPages, setFbPages] = useState<FacebookPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSubTab, setActiveSubTab] = useState('supabase');
  const [saving, setSaving] = useState<string | null>(null);
  const [fbToken, setFbToken] = useState('');
  const [cfAccountId, setCfAccountId] = useState('');
  const [cfApiKey, setCfApiKey] = useState('');
  const [validatingCloudflare, setValidatingCloudflare] = useState(false);
  const [fetchedFbPages, setFetchedFbPages] = useState<any[]>([]);
  const [fetchingFb, setFetchingFb] = useState(false);
  const [supabaseStatus, setSupabaseStatus] = useState<'idle' | 'verifying' | 'connected' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elApiKey, setElApiKey] = useState('');
  const [cerebrasApiKey, setCerebrasApiKey] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const maskValue = (value?: string, start = 6, end = 4) => {
    if (!value) return 'Not set';
    if (value.length <= start + end) return '•'.repeat(Math.max(value.length, 8));
    return `${value.slice(0, start)}...${value.slice(-end)}`;
  };

  const hasSupabaseSaved = Boolean(settings.supabase_url || settings.supabase_access_token || settings.supabase_service_role_key);
  const hasBloggerSaved = Boolean(settings.blogger_client_id || settings.blogger_client_secret || settings.blogger_refresh_token);
  const hasGitHubSaved = Boolean(settings.github_pat);
  const hasImgBBSaved = Boolean(settings.imgbb_api_key);
  const hasAdsSaved = Boolean(settings.ads_html || settings.ads_scripts || settings.ads_placement);
  const normalizeClientSettings = (raw: any = {}) => {
    const safeArray = (value: any) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    };

    return {
      ...raw,
      cloudflare_configs: safeArray(raw.cloudflare_configs),
      elevenlabs_keys: safeArray(raw.elevenlabs_keys),
      cerebras_keys: safeArray(raw.cerebras_keys).length ? safeArray(raw.cerebras_keys) : safeArray((raw as any).lightning_keys),
      ads_placement: raw.ads_placement || 'after'
    };
  };

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [setRes, fbRes, statusRes] = await Promise.all([
        fetch('/api/settings').then(r => r.ok ? r.json() : {} as any),
        fetch('/api/facebook-pages').then(r => r.ok ? r.json() : []),
        fetch('/api/supabase/status').then(r => r.ok ? r.json() : null)
      ]);
      setSettings(normalizeClientSettings(setRes));
      setFbPages(fbRes);

      if (statusRes?.connected) {
        setSupabaseStatus('connected');
      } else if (statusRes?.configured) {
        setSupabaseStatus('error');
      } else {
        setSupabaseStatus('idle');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const verifySupabase = async (url?: string, key?: string) => {
    setSupabaseStatus('verifying');
    try {
      const res = await fetch('/api/settings/verify-supabase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url || settings.supabase_url,
          service_role_key: key || settings.supabase_service_role_key
        })
      });
      if (res.ok) setSupabaseStatus('connected');
      else setSupabaseStatus('error');
    } catch (err) {
      setSupabaseStatus('error');
    }
  };

  const saveSection = async (section: string, data: any) => {
    setSaving(section);
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _section: section, ...data })
      });
      
      if (!res.ok) {
        const errData = await res.json();
        // Check for specific Supabase schema errors
        if (errData.error?.includes('column') || errData.error?.includes('relation')) {
          setError(`Database Schema Error: ${errData.error}. Please ensure your 'settings' table has the correct columns. Run the SQL below to fix.`);
        } else {
          const serverMessage = errData.error || 'Failed to save settings';
          if (section !== 'supabase' && /invalid api key/i.test(serverMessage)) {
            throw new Error('Unable to save settings because Supabase credentials are invalid. Please update Supabase Service Role Key first.');
          }
          throw new Error(serverMessage);
        }
        return;
      }
      
      const updated = await res.json();
      setSettings(normalizeClientSettings(updated));
      await fetchData();
      
      // If we just saved Supabase settings, re-verify status
      if (section === 'supabase') {
        const hasManualCredentials = Boolean(data.supabase_url && data.supabase_service_role_key);
        const verifyRes = await fetch('/api/settings/verify-supabase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hasManualCredentials ? {
            url: data.supabase_url,
            service_role_key: data.supabase_service_role_key
          } : {})
        });
        if (verifyRes.ok) setSupabaseStatus('connected');
        else setSupabaseStatus('error');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message);
      setTimeout(() => setError(null), 10000);
    } finally {
      setSaving(null);
    }
  };

  const deleteSettingField = async (field: string) => {
    try {
      const res = await fetch(`/api/settings/field/${field}`, { method: 'DELETE' });
      if (res.ok) {
        const updated = await res.json();
        setSettings(normalizeClientSettings(updated));
        await fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const verifyCloudflareCredentials = async (account_id: string, api_key: string) => {
    const res = await fetch('/api/settings/verify-cloudflare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id, api_key })
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || 'Cloudflare validation failed');
    }
    return payload;
  };

  const saveCloudflareConfigs = async (configs: any[]) => {
    await saveSection('cloudflare', {
      cloudflare_configs: configs,
      cloudflare_image_model: '@cf/leonardo/phoenix-1.0'
    });
  };

  const handleAddCloudflareConfig = async () => {
    const account_id = cfAccountId.trim();
    const api_key = cfApiKey.trim();
    if (!account_id || !api_key) {
      setError('Cloudflare Account ID and API Key are required.');
      return;
    }

    try {
      setValidatingCloudflare(true);
      await verifyCloudflareCredentials(account_id, api_key);

      const newConfigs = [
        ...(settings.cloudflare_configs || []),
        {
          account_id,
          api_key,
          success_calls: 0,
          failed_calls: 0,
          total_calls: 0,
          monthly_calls: 0,
          monthly_period: new Date().toISOString().slice(0, 7),
          active: true,
        }
      ];

      await saveCloudflareConfigs(newConfigs);
      setCfAccountId('');
      setCfApiKey('');
    } catch (err: any) {
      setError(err.message || 'Unable to add Cloudflare configuration');
    } finally {
      setValidatingCloudflare(false);
    }
  };

  const handleFetchFbPages = async () => {
    if (!fbToken) return;
    setFetchingFb(true);
    try {
      const res = await fetch('/api/facebook/pages-from-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: fbToken })
      });
      
      if (res.ok) {
        const payload = await res.json();
        setFetchedFbPages(payload.pages || []);
      } else {
        const errorPayload = await res.json();
        throw new Error(errorPayload.error || 'Failed to fetch Facebook pages');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to fetch Facebook pages');
    } finally {
      setFetchingFb(false);
    }
  };

  const connectFbPage = async (page: any) => {
    try {
      const res = await fetch('/api/facebook-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: page.id,
          name: page.name,
          access_token: page.access_token || fbToken,
          status: 'valid'
        })
      });
      if (res.ok) {
        setFetchedFbPages(prev => prev.filter(p => p.id !== page.id));
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const deleteFbPage = async (id: string) => {
    try {
      const res = await fetch(`/api/facebook-pages/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const menuItems = [
    { id: 'supabase', label: 'Supabase', icon: Database },
    { id: 'blogger-oauth', label: 'Blogger OAuth Credentials', icon: KeyIcon },
    { id: 'github', label: 'GitHub', icon: Github },
    { id: 'cloudflare', label: 'Cloudflare', icon: Cloud },
    { id: 'facebook', label: 'Facebook', icon: Facebook },
    { id: 'elevenlabs', label: 'ElevenLabs', icon: Mic },
    { id: 'cerebras', label: 'Cerebras AI', icon: Video },
    { id: 'imgbb', label: 'ImgBB', icon: ImageIcon },
    { id: 'ads', label: 'Ads Settings', icon: Layout },
  ];

  if (loading) return (
    <div className="flex-1 flex items-center justify-center min-h-[60vh]">
      <div className="flex flex-col items-center gap-3">
        <RefreshCw className="animate-spin text-indigo-500 w-8 h-8" />
        <p className="text-zinc-500 text-sm">Loading settings...</p>
      </div>
    </div>
  );

  const activeItem = menuItems.find(m => m.id === activeSubTab);

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-screen bg-black">
      {/* Desktop Sidebar Nav */}
      <div className="hidden lg:flex w-64 xl:w-72 bg-zinc-950 border-r border-zinc-800/80 flex-col sticky top-0 h-screen overflow-y-auto no-scrollbar">
        <div className="p-6 pb-4 border-b border-zinc-800/60">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 bg-indigo-500/10 rounded-xl flex items-center justify-center">
              <SettingsIcon className="w-4 h-4 text-indigo-400" />
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight">Settings</h2>
          </div>
          <p className="text-zinc-500 text-xs ml-11">Configure your platform</p>
        </div>
        <nav className="flex-1 p-3 space-y-1 py-4">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSubTab(item.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group text-left",
                activeSubTab === item.id
                  ? "bg-indigo-600/10 text-indigo-300 border border-indigo-500/20"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 border border-transparent"
              )}
            >
              <div className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all",
                activeSubTab === item.id ? "bg-indigo-500/20" : "bg-zinc-800/60 group-hover:bg-zinc-700/60"
              )}>
                <item.icon className={cn("w-4 h-4", activeSubTab === item.id ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-400")} />
              </div>
              <span className={cn("font-semibold text-sm truncate", activeSubTab === item.id ? "text-white" : "")}>{item.label}</span>
              {activeSubTab === item.id && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />}
            </button>
          ))}
        </nav>
      </div>

      {/* Mobile Nav - Sticky tab bar */}
      <div className="lg:hidden sticky top-[57px] z-30 bg-zinc-950/95 backdrop-blur-md border-b border-zinc-800">
        {/* Current section header with dropdown toggle */}
        <button
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
          className="w-full flex items-center justify-between px-4 py-3"
        >
          <div className="flex items-center gap-3">
            {activeItem && (
              <div className="w-7 h-7 bg-indigo-500/10 rounded-lg flex items-center justify-center">
                <activeItem.icon className="w-3.5 h-3.5 text-indigo-400" />
              </div>
            )}
            <span className="text-white font-semibold text-sm">{activeItem?.label || 'Settings'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 text-xs">Change section</span>
            <ChevronRight className={cn("w-4 h-4 text-zinc-500 transition-transform", mobileNavOpen && "rotate-90")} />
          </div>
        </button>
        {/* Mobile dropdown */}
        <AnimatePresence>
          {mobileNavOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-t border-zinc-800"
            >
              <div className="p-2 grid grid-cols-2 gap-1.5 max-h-64 overflow-y-auto">
                {menuItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => { setActiveSubTab(item.id); setMobileNavOpen(false); }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all text-left",
                      activeSubTab === item.id
                        ? "bg-indigo-600/15 text-indigo-300 border border-indigo-500/20"
                        : "text-zinc-400 hover:bg-zinc-800 border border-transparent"
                    )}
                  >
                    <item.icon className={cn("w-4 h-4 flex-shrink-0", activeSubTab === item.id ? "text-indigo-400" : "text-zinc-600")} />
                    <span className="text-xs font-semibold truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Settings Content */}
      <div className="flex-1 p-4 sm:p-6 lg:p-10 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSubTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-6 p-6 bg-rose-500/10 border border-rose-500/20 rounded-[2rem] flex flex-col gap-4 text-rose-500 shadow-xl shadow-rose-500/5"
              >
                <div className="flex items-center gap-3">
                  <XCircle className="w-6 h-6" />
                  <p className="font-bold text-lg">{error.includes('Database Schema Error') ? 'Database Schema Error' : 'Error'}</p>
                </div>
                <p className="text-rose-400/80 leading-relaxed">{error}</p>
                {error.includes('Database Schema Error') && (
                  <div className="mt-2 p-4 bg-zinc-950 rounded-xl border border-rose-500/20">
                    <p className="text-xs font-mono text-zinc-500 mb-2">Run this SQL in your Supabase SQL Editor:</p>
                    <pre className="text-[10px] font-mono text-emerald-500 overflow-x-auto whitespace-pre-wrap">
{`CREATE TABLE IF NOT EXISTS settings (
  id BIGINT PRIMARY KEY DEFAULT 1,
  supabase_url TEXT,
  supabase_service_role_key TEXT,
  supabase_access_token TEXT,
  cloudflare_configs JSONB DEFAULT '[]',
  elevenlabs_keys JSONB DEFAULT '[]',
  cerebras_keys JSONB DEFAULT '[]',
  github_pat TEXT,
  imgbb_api_key TEXT,
  ads_placement TEXT DEFAULT 'after',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure only one row exists
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Add missing columns if table exists
ALTER TABLE settings ADD COLUMN IF NOT EXISTS cloudflare_configs JSONB DEFAULT '[]';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS elevenlabs_keys JSONB DEFAULT '[]';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS cerebras_keys JSONB DEFAULT '[]';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS supabase_url TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS supabase_service_role_key TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS supabase_access_token TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS blogger_client_id TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS blogger_client_secret TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS blogger_refresh_token TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ads_html TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS ads_scripts TEXT;`}
                    </pre>
                  </div>
                )}
              </motion.div>
            )}
            {activeSubTab === 'supabase' && (
              <div className="space-y-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-3xl font-bold text-white tracking-tight">Supabase Configuration</h3>
                    <p className="text-zinc-400 mt-2 text-lg">Manage your database connection and access tokens.</p>
                  </div>
                  <div className={cn(
                    "px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2",
                    supabaseStatus === 'connected' ? "bg-emerald-500/10 text-emerald-500" : 
                    supabaseStatus === 'error' ? "bg-rose-500/10 text-rose-500" : "bg-zinc-800 text-zinc-500"
                  )}>
                    <div className={cn("w-2 h-2 rounded-full", supabaseStatus === 'connected' ? "bg-emerald-500 animate-pulse" : "bg-zinc-500")} />
                    {supabaseStatus === 'verifying' ? 'Verifying...' : supabaseStatus === 'connected' ? 'Connected' : supabaseStatus === 'error' ? 'Connection Failed' : 'Idle'}
                  </div>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="grid grid-cols-1 gap-8">
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Supabase URL</label>
                      <div className="relative group">
                        <Database className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                        <input 
                          type="text" 
                          value={settings.supabase_url || ''}
                          onChange={(e) => setSettings({ ...settings, supabase_url: e.target.value })}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                          placeholder="https://your-project.supabase.co"
                        />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Access Token</label>
                      <div className="relative group">
                        <KeyIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                        <input 
                          type="password" 
                          value={settings.supabase_access_token || ''}
                          onChange={(e) => setSettings({ ...settings, supabase_access_token: e.target.value })}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                          placeholder="sbp_..."
                        />
                      </div>
                    </div>
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Service Role Key</label>
                      <div className="relative group">
                        <Shield className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                        <input 
                          type="password" 
                          value={settings.supabase_service_role_key || ''}
                          onChange={(e) => setSettings({ ...settings, supabase_service_role_key: e.target.value })}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                          placeholder="eyJhbG..."
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-4 pt-4">
                    <button 
                      onClick={() => saveSection('supabase', { 
                        supabase_url: settings.supabase_url, 
                        supabase_access_token: settings.supabase_access_token,
                        supabase_service_role_key: settings.supabase_service_role_key 
                      })}
                      disabled={saving === 'supabase'}
                      className="w-full bg-indigo-600 text-white py-5 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center justify-center gap-3 text-lg"
                    >
                      {saving === 'supabase' ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />}
                      Save & Connect Configuration
                    </button>
                    <p className="text-center text-zinc-500 text-sm">
                      Saving will verify the connection and store credentials in your database.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Saved Configurations</h4>
                    {hasSupabaseSaved ? (
                      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-5 space-y-3">
                        <p className="text-white font-semibold break-all">{settings.supabase_url || 'URL not set'}</p>
                        <p className="text-xs text-zinc-500 font-mono">Access token: {maskValue(settings.supabase_access_token)}</p>
                        <p className="text-xs text-zinc-500 font-mono">Service role: {maskValue(settings.supabase_service_role_key)}</p>
                        <div className="flex items-center justify-between">
                          <span className={cn("text-[10px] uppercase tracking-widest font-bold", supabaseStatus === 'connected' ? 'text-emerald-500' : 'text-rose-400')}>
                            {supabaseStatus === 'connected' ? 'Connected' : 'Not connected'}
                          </span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => saveSection('supabase', { supabase_url: settings.supabase_url, supabase_access_token: settings.supabase_access_token, supabase_service_role_key: settings.supabase_service_role_key })} className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-bold">Edit</button>
                            <button onClick={() => { deleteSettingField('supabase_url'); deleteSettingField('supabase_access_token'); deleteSettingField('supabase_service_role_key'); }} className="px-3 py-1 rounded-lg bg-rose-500/10 text-rose-400 text-xs font-bold">Delete</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-10 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">No saved Supabase configuration yet.</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'blogger-oauth' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">Blogger OAuth Credentials</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Global OAuth credentials used for all Blogger connections and publishing.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Client ID</label>
                    <div className="relative group">
                      <KeyIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="text"
                        value={settings.blogger_client_id || ''}
                        onChange={(e) => setSettings({ ...settings, blogger_client_id: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                        placeholder="Google OAuth Client ID"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Client Secret</label>
                    <div className="relative group">
                      <Shield className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="password"
                        value={settings.blogger_client_secret || ''}
                        onChange={(e) => setSettings({ ...settings, blogger_client_secret: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                        placeholder="Google OAuth Client Secret"
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Refresh Token</label>
                    <div className="relative group">
                      <RefreshCw className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="password"
                        value={settings.blogger_refresh_token || ''}
                        onChange={(e) => setSettings({ ...settings, blogger_refresh_token: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                        placeholder="Blogger OAuth Refresh Token"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => saveSection('blogger-oauth', {
                      blogger_client_id: settings.blogger_client_id,
                      blogger_client_secret: settings.blogger_client_secret,
                      blogger_refresh_token: settings.blogger_refresh_token
                    })}
                    disabled={saving === 'blogger-oauth'}
                    className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-xl shadow-indigo-500/20 disabled:opacity-50 text-lg flex items-center justify-center gap-3"
                  >
                    {saving === 'blogger-oauth' ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />}
                    Save Blogger OAuth Credentials
                  </button>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Saved Configurations</h4>
                    {hasBloggerSaved ? (
                    <div className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20">
                      <p className="text-zinc-400 text-sm">Saved Blogger OAuth credentials.</p>

                      <div className="flex items-center gap-3">
                      <button
                        onClick={async () => { const res = await fetch('/api/blogger/available-accounts'); if (!res.ok) { const payload = await res.json().catch(() => ({})); alert(payload.error || 'Unable to fetch Blogger accounts'); return; } const blogs = await res.json(); alert(`Fetched ${Array.isArray(blogs) ? blogs.length : 0} Blogger account(s). Open Blogger Accounts page to connect them.`); }}
                        className="text-emerald-400 hover:text-emerald-300 text-sm font-bold"
                      >
                        Fetch Blogger Accounts
                      </button>
                      <button
                        onClick={() => saveSection('blogger-oauth', {
                          blogger_client_id: settings.blogger_client_id,
                          blogger_client_secret: settings.blogger_client_secret,
                          blogger_refresh_token: settings.blogger_refresh_token
                        })}
                        className="text-indigo-400 hover:text-indigo-300 text-sm font-bold"
                      >
                        Edit
                      </button>

                      <button
                        onClick={() => {
                          deleteSettingField('blogger_client_id');
                          deleteSettingField('blogger_client_secret');
                          deleteSettingField('blogger_refresh_token');
                        }}
                        className="text-rose-400 hover:text-rose-300 text-sm font-bold"
                      >
                        Delete
                      </button>

                      </div>

                    </div>
                  ) : (
                    <div className="p-10 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">No Blogger OAuth credentials saved yet.</div>
                  )}
                </div>
              </div>
            </div>
            )}

            {activeSubTab === 'github' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">GitHub Integration</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Connect your GitHub account for Actions and Remotion pipelines.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Personal Access Token (PAT)</label>
                    <div className="relative group">
                      <Github className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                      <input 
                        type="password" 
                        value={settings.github_pat || ''}
                        onChange={(e) => setSettings({ ...settings, github_pat: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                        placeholder="ghp_..."
                      />
                    </div>
                    <p className="text-xs text-zinc-500 ml-1">Required for triggering GitHub Actions and the Remotion video rendering pipeline.</p>
                  </div>

                  <button 
                    onClick={() => saveSection('github', { github_pat: settings.github_pat })}
                    disabled={saving === 'github'}
                    className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {saving === 'github' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    Save Token
                  </button>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Saved Configurations</h4>
                    {hasGitHubSaved ? (
                      <div className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20">
                        <div>
                          <p className="text-zinc-400 text-sm">Saved PAT: <span className="text-white font-mono">{maskValue(settings.github_pat)}</span></p>
                          <p className="text-[10px] text-emerald-500 uppercase tracking-widest font-bold mt-1">Connected</p>
                        </div>
                        <div className="flex items-center gap-3"><button onClick={() => saveSection('github', { github_pat: settings.github_pat })} className="text-indigo-400 hover:text-indigo-300 text-sm font-bold">Edit</button><button onClick={() => deleteSettingField('github_pat')} className="text-rose-400 hover:text-rose-300 text-sm font-bold">Delete</button></div>
                      </div>
                    ) : (
                      <div className="p-10 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">No GitHub PAT saved yet.</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'cloudflare' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">Cloudflare Workers AI</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Add multiple Workers AI configurations for automatic rotation.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Account ID</label>
                      <input 
                        type="text" 
                        value={cfAccountId}
                        onChange={(e) => setCfAccountId(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-all"
                        placeholder="Cloudflare Account ID"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">API Key</label>
                      <input 
                        type="password" 
                        value={cfApiKey}
                        onChange={(e) => setCfApiKey(e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-all"
                        placeholder="Workers AI API Key"
                      />
                    </div>
                  </div>
                  <button 
                    onClick={handleAddCloudflareConfig}
                    disabled={validatingCloudflare || saving === 'cloudflare'}
                    className="w-full bg-zinc-800 text-white py-4 rounded-2xl font-bold hover:bg-zinc-700 transition-all border border-zinc-700 flex items-center justify-center gap-2"
                  >
                    {validatingCloudflare || saving === 'cloudflare' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
                    Add Configuration
                  </button>
                  <p className="text-xs text-zinc-500">Workers AI is locked for image generation with <span className="text-zinc-300 font-mono">@cf/leonardo/phoenix-1.0</span>. Text generation is handled by Cerebras AI.</p>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Configured Integrations</h4>
                    {settings.cloudflare_configs?.map((config: any, idx: number) => (
                      <div key={idx} className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20 group hover:border-zinc-700 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 bg-orange-500/10 rounded-xl flex items-center justify-center">
                            <Cloud className="text-orange-500 w-5 h-5" />
                          </div>
                          <div>
                            <p className="text-white font-medium font-mono text-sm">{config.account_id}</p>
                            <p className="text-xs text-zinc-500 font-mono">API: {maskValue(config.api_key, 5, 3)}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <BarChart3 className="w-3 h-3 text-zinc-500" />
                              <span className="text-xs text-zinc-500">Success: {config.success_calls || 0} • Failed: {config.failed_calls || 0} • Total: {config.total_calls || 0} • Monthly: {config.monthly_calls || 0}</span>
                              <span className={cn('text-[10px] uppercase tracking-widest font-bold ml-2', (config.failed_calls || 0) > (config.success_calls || 0) ? 'text-amber-400' : 'text-emerald-500')}>{(config.failed_calls || 0) > (config.success_calls || 0) ? 'Needs attention' : 'Active'}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              const account_id = prompt('Cloudflare Account ID', config.account_id || '') || config.account_id;
                              const api_key = prompt('Cloudflare API Key', config.api_key || '') || config.api_key;
                              try {
                                setValidatingCloudflare(true);
                                await verifyCloudflareCredentials(account_id, api_key);
                                const newConfigs = settings.cloudflare_configs.map((c: any, i: number) => i === idx ? { ...c, account_id, api_key, active: true } : c);
                                await saveCloudflareConfigs(newConfigs);
                              } catch (err: any) {
                                setError(err.message || 'Cloudflare validation failed');
                              } finally {
                                setValidatingCloudflare(false);
                              }
                            }}
                            className="px-3 py-1 rounded-lg bg-indigo-600/15 text-indigo-300 hover:bg-indigo-600/25 transition-colors text-xs font-bold"
                          >
                            Edit
                          </button>
                          <button 
                            onClick={async () => {
                              const newConfigs = settings.cloudflare_configs.filter((_: any, i: number) => i !== idx);
                              await saveCloudflareConfigs(newConfigs);
                            }}
                            className="px-3 py-1 rounded-lg bg-rose-600/15 text-rose-300 hover:bg-rose-600/25 transition-colors text-xs font-bold"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    {(!settings.cloudflare_configs || settings.cloudflare_configs.length === 0) && (
                      <div className="p-8 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">
                        No configurations added yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'facebook' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">Facebook Page Connection</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Connect and manage your Facebook Pages for automated posting.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Access Token</label>
                    <div className="flex flex-col sm:flex-row gap-4">
                      <input 
                        type="text" 
                        value={fbToken}
                        onChange={(e) => setFbToken(e.target.value)}
                        placeholder="Enter Access Token (User, Page, or System)..."
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-indigo-500 transition-all text-lg"
                      />
                      <button 
                        onClick={handleFetchFbPages}
                        disabled={fetchingFb || !fbToken}
                        className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 whitespace-nowrap disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {fetchingFb ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Facebook className="w-5 h-5" />}
                        Fetch Pages
                      </button>
                    </div>
                    <p className="text-xs text-zinc-500 ml-1">Tokens are validated before fetching pages. Supports User, Page, and System tokens.</p>
                  </div>

                  {fetchedFbPages.length > 0 && (
                    <div className="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                      <h4 className="text-sm font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4" />
                        Pages Found
                      </h4>
                      <div className="grid grid-cols-1 gap-3">
                        {fetchedFbPages.map(page => (
                          <div key={page.id} className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20 group hover:border-indigo-500/50 transition-all">
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center">
                                <Facebook className="text-indigo-500 w-5 h-5" />
                              </div>
                              <div>
                                <p className="text-white font-bold">{page.name}</p>
                              <p className="text-[11px] text-zinc-500 font-mono">Page ID: {page.page_id || page.id}</p>
                                <p className="text-xs text-zinc-500">{page.category}</p>
                              </div>
                            </div>
                            <button 
                              onClick={() => connectFbPage(page)}
                              className="bg-zinc-800 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-indigo-600 transition-all flex items-center gap-2"
                            >
                              <Plus className="w-4 h-4" />
                              Connect
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Configured Integrations</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {fbPages.map(page => (
                        <div key={page.id} className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between group hover:border-zinc-700 transition-colors shadow-lg shadow-black/20">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center">
                              <Facebook className="text-blue-500 w-6 h-6" />
                            </div>
                            <div>
                              <p className="text-white font-bold">{page.name}</p>
                              <p className="text-[11px] text-zinc-500 font-mono">Page ID: {page.page_id || page.id}</p>
                              <div className="flex items-center gap-2 mt-1">
                                <div className={cn("w-1.5 h-1.5 rounded-full", page.status === 'valid' ? "bg-emerald-500" : "bg-rose-500")} />
                                <span className={cn(
                                  "text-[10px] uppercase font-bold tracking-widest",
                                  page.status === 'valid' ? "text-emerald-500" : "text-rose-500"
                                )}>
                                  {page.status}
                                </span>
                              </div>
                            </div>
                          </div>
                          <button 
                            onClick={() => deleteFbPage(page.id)}
                            className="p-2 text-zinc-600 hover:text-rose-500 transition-colors"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    {fbPages.length === 0 && (
                      <div className="p-12 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">
                        No Facebook pages connected yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'elevenlabs' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">ElevenLabs Voice Settings</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Add multiple API keys for voice generation with automatic rotation.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">New API Key</label>
                    <div className="flex flex-col sm:flex-row gap-4">
                      <input 
                        type="password"
                        value={elApiKey}
                        onChange={(e) => setElApiKey(e.target.value)}
                        placeholder="Enter ElevenLabs API Key..."
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-indigo-500 transition-all text-lg"
                      />
                      <button 
                        onClick={() => {
                          if (elApiKey.trim()) {
                            const newKeys = [...(settings.elevenlabs_keys || []), { key: elApiKey.trim(), success_calls: 0, failed_calls: 0, total_calls: 0, monthly_calls: 0, monthly_period: new Date().toISOString().slice(0,7) }];
                            saveSection('elevenlabs', { elevenlabs_keys: newKeys });
                            setElApiKey('');
                          }
                        }}
                        disabled={!elApiKey.trim() || saving === 'elevenlabs'}
                        className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 whitespace-nowrap disabled:opacity-50 flex items-center gap-2 justify-center"
                      >
                        {saving === 'elevenlabs' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                        Save Key
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Configured API Keys</h4>
                    <div className="space-y-3">
                      {settings.elevenlabs_keys?.map((item: any, idx: number) => (
                        <div key={idx} className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20 group hover:border-zinc-700 transition-colors">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center">
                              <Mic className="text-indigo-500 w-5 h-5" />
                            </div>
                            <div>
                              <p className="text-white font-medium font-mono text-xs">{maskValue(item.key, 8, 4)}</p>
                              <div className="flex items-center gap-4 mt-1">
                                <div className="flex items-center gap-1.5">
                                  <BarChart3 className="w-3 h-3 text-zinc-500" />
                                  <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{item.success_calls || 0} Success</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Database className="w-3 h-3 text-zinc-500" />
                                  <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{item.failed_calls || 0} Failed • {item.total_calls || 0} Total • {item.monthly_calls || 0} Monthly</span>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const key = prompt('ElevenLabs API Key', item.key || '') || item.key;
                                const newKeys = settings.elevenlabs_keys.map((k: any, i: number) => i === idx ? { ...k, key } : k);
                                saveSection('elevenlabs', { elevenlabs_keys: newKeys });
                              }}
                              className="p-2 text-zinc-600 hover:text-indigo-400 transition-colors"
                            >
                              <Save className="w-5 h-5" />
                            </button>
                            <button 
                              onClick={() => {
                                const newKeys = settings.elevenlabs_keys.filter((_: any, i: number) => i !== idx);
                                saveSection('elevenlabs', { elevenlabs_keys: newKeys });
                              }}
                              className="p-2 text-zinc-600 hover:text-rose-500 transition-colors"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {(!settings.elevenlabs_keys || settings.elevenlabs_keys.length === 0) && (
                      <div className="p-12 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">
                        No API keys added yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'cerebras' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">Cerebras AI Text Generation</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Manage rotating Cerebras API keys for blog text generation.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-4">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">New API Key</label>
                    <div className="flex flex-col sm:flex-row gap-4">
                      <input 
                        type="password"
                        value={cerebrasApiKey}
                        onChange={(e) => setCerebrasApiKey(e.target.value)}
                        placeholder="Enter Cerebras AI API Key..."
                        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl px-6 py-4 text-white focus:outline-none focus:border-indigo-500 transition-all text-lg"
                      />
                      <button 
                        onClick={() => {
                          if (cerebrasApiKey.trim()) {
                            const newKeys = [...(settings.cerebras_keys || []), { key: cerebrasApiKey.trim(), success_calls: 0, failed_calls: 0, total_calls: 0, monthly_calls: 0, monthly_period: new Date().toISOString().slice(0,7) }];
                            saveSection('cerebras', { cerebras_keys: newKeys });
                            setCerebrasApiKey('');
                          }
                        }}
                        disabled={!cerebrasApiKey.trim() || saving === 'cerebras'}
                        className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 whitespace-nowrap disabled:opacity-50 flex items-center gap-2 justify-center"
                      >
                        {saving === 'cerebras' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                        Save Key
                      </button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Configured API Keys</h4>
                    <div className="space-y-3">
                      {settings.cerebras_keys?.map((item: any, idx: number) => (
                        <div key={idx} className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20 group hover:border-zinc-700 transition-colors">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center">
                              <Video className="text-indigo-500 w-5 h-5" />
                            </div>
                            <div>
                              <p className="text-white font-medium font-mono text-xs">{maskValue(item.key, 8, 4)}</p>
                              <div className="flex items-center gap-4 mt-1">
                                <div className="flex items-center gap-1.5">
                                  <BarChart3 className="w-3 h-3 text-zinc-500" />
                                  <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider">{item.success_calls || 0} Success • {item.failed_calls || 0} Failed • {item.total_calls || 0} Total • {item.monthly_calls || 0} Monthly</span>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const key = prompt('Cerebras AI API Key', item.key || '') || item.key;
                                const newKeys = settings.cerebras_keys.map((k: any, i: number) => i === idx ? { ...k, key } : k);
                                saveSection('cerebras', { cerebras_keys: newKeys });
                              }}
                              className="p-2 text-zinc-600 hover:text-indigo-400 transition-colors"
                            >
                              <Save className="w-5 h-5" />
                            </button>
                            <button 
                              onClick={() => {
                                const newKeys = settings.cerebras_keys.filter((_: any, i: number) => i !== idx);
                                saveSection('cerebras', { cerebras_keys: newKeys });
                              }}
                              className="p-2 text-zinc-600 hover:text-rose-500 transition-colors"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {(!settings.cerebras_keys || settings.cerebras_keys.length === 0) && (
                      <div className="p-12 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">
                        No API keys added yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'imgbb' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">ImgBB Configuration</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Free image hosting for blog post images. Get your free API key at <span className="text-indigo-400 font-mono">api.imgbb.com</span>.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">API Key</label>
                    <div className="relative group">
                      <ImageIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                      <input
                        type="password"
                        value={settings.imgbb_api_key || ''}
                        onChange={(e) => setSettings({ ...settings, imgbb_api_key: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all text-lg"
                        placeholder="Enter your ImgBB API key..."
                      />
                    </div>
                    <p className="text-xs text-zinc-500 ml-1">Free permanent image hosting. Sign up free at api.imgbb.com to get your key.</p>
                  </div>

                  <button
                    onClick={() => saveSection('imgbb', { imgbb_api_key: settings.imgbb_api_key })}
                    disabled={saving === 'imgbb'}
                    className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {saving === 'imgbb' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    Save Settings
                  </button>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Saved Configuration</h4>
                    {hasImgBBSaved ? (
                      <div className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 flex items-center justify-between shadow-lg shadow-black/20">
                        <div>
                          <p className="text-zinc-400 text-sm">Saved ImgBB API Key</p>
                          <p className="text-white font-mono text-xs">{maskValue(settings.imgbb_api_key)}</p>
                          <p className="text-[10px] text-emerald-500 uppercase tracking-widest font-bold mt-1">Configured</p>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => saveSection('imgbb', { imgbb_api_key: settings.imgbb_api_key })} className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-bold">Edit</button>
                          <button onClick={() => deleteSettingField('imgbb_api_key')} className="px-3 py-1 rounded-lg bg-rose-500/10 text-rose-400 text-xs font-bold">Delete</button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-10 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">No ImgBB API key saved yet.</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeSubTab === 'ads' && (
              <div className="space-y-8">
                <div>
                  <h3 className="text-3xl font-bold text-white tracking-tight">Ads Settings</h3>
                  <p className="text-zinc-400 mt-2 text-lg">Configure advertisements to be automatically injected into your Blogger posts.</p>
                </div>

                <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl shadow-black/30 space-y-8">
                  <div className="space-y-6">
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Ad Placement</label>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {['before', 'inside', 'after'].map((pos) => (
                          <button
                            key={pos}
                            onClick={() => setSettings({ ...settings, ads_placement: pos })}
                            className={cn(
                              "py-3 rounded-xl font-bold border transition-all capitalize",
                              settings.ads_placement === pos 
                                ? "bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/20" 
                                : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700"
                            )}
                          >
                            {pos} Content
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Ad HTML Code</label>
                      <div className="relative group">
                        <Code className="absolute left-4 top-4 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                        <textarea 
                          value={settings.ads_html || ''}
                          onChange={(e) => setSettings({ ...settings, ads_html: e.target.value })}
                          rows={4}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono text-sm resize-none"
                          placeholder="<div class='ad-container'>...</div>"
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <label className="text-sm font-bold text-zinc-400 uppercase tracking-wider ml-1">Ad Scripts</label>
                      <div className="relative group">
                        <Layout className="absolute left-4 top-4 w-5 h-5 text-zinc-600 group-focus-within:text-indigo-500 transition-colors" />
                        <textarea 
                          value={settings.ads_scripts || ''}
                          onChange={(e) => setSettings({ ...settings, ads_scripts: e.target.value })}
                          rows={4}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-12 pr-4 py-4 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all font-mono text-sm resize-none"
                          placeholder="<script async src='...'></script>"
                        />
                      </div>
                    </div>
                  </div>

                  <button 
                    onClick={() => saveSection('ads', { 
                      ads_html: settings.ads_html, 
                      ads_scripts: settings.ads_scripts,
                      ads_placement: settings.ads_placement
                    })}
                    disabled={saving === 'ads'}
                    className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold hover:bg-indigo-500 transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {saving === 'ads' ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    Save Ads Settings
                  </button>

                  <div className="space-y-4">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-[0.14em]">Saved Configurations</h4>
                    {hasAdsSaved ? (
                      <div className="bg-zinc-950/80 border border-zinc-800 rounded-3xl p-5 space-y-3 shadow-lg shadow-black/20">
                        <p className="text-zinc-400 text-sm">Saved Ads Configuration</p>
                        <p className="text-xs text-zinc-500">Placement: <span className="text-white">{settings.ads_placement || 'after'}</span></p>
                        <p className="text-xs text-zinc-500">HTML: <span className="text-white">{settings.ads_html ? `${settings.ads_html.length} chars` : 'Not set'}</span></p>
                        <p className="text-xs text-zinc-500">Scripts: <span className="text-white">{settings.ads_scripts ? `${settings.ads_scripts.length} chars` : 'Not set'}</span></p>
                        <div className="flex gap-2">
                          <button onClick={() => saveSection('ads', { ads_html: settings.ads_html, ads_scripts: settings.ads_scripts, ads_placement: settings.ads_placement })} className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-xs font-bold">Edit</button>
                          <button onClick={() => { deleteSettingField('ads_html'); deleteSettingField('ads_scripts'); deleteSettingField('ads_placement'); }} className="px-3 py-1 rounded-lg bg-rose-500/10 text-rose-400 text-xs font-bold">Delete</button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-10 text-center text-zinc-600 italic border border-dashed border-zinc-800 rounded-2xl">No ads settings saved yet.</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-indigo-500/30">
      <Sidebar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        isOpen={sidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />
      
      <main className="lg:pl-64 min-h-screen flex flex-col">
        {/* Mobile Header */}
        <header className="lg:hidden flex items-center justify-between p-4 bg-zinc-950 border-b border-zinc-800 sticky top-0 z-40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <Zap className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-white">Blog Automator</span>
          </div>
          <button 
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-zinc-400 hover:text-white"
          >
            <Menu className="w-6 h-6" />
          </button>
        </header>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex-1 flex flex-col"
          >
            {activeTab === 'dashboard' && <Dashboard />}
            {activeTab === 'blogger' && <BloggerAccounts />}
            {activeTab === 'blog-scheduler' && <Scheduler type="blog" />}
            {activeTab === 'video-scheduler' && <Scheduler type="video" />}
            {activeTab === 'settings' && <Settings />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
