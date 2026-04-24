import React, { useEffect, useState } from 'react';
import { Copy, Check, ShieldCheck, ExternalLink } from 'lucide-react';

const PATHS = [
  { path: '/', label: 'Homepage', desc: 'Main landing & login page' },
  { path: '/about', label: 'About', desc: 'Company / product overview' },
  { path: '/privacy-policy', label: 'Privacy Policy', desc: 'How user data is handled' },
  { path: '/terms', label: 'Terms of Service', desc: 'Usage terms & conditions' },
  { path: '/contact', label: 'Contact', desc: 'Support contact details' },
  { path: '/data-deletion', label: 'Data Deletion', desc: 'User data deletion instructions' },
];

const AppVerification = () => {
  const [origin, setOrigin] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPath(key);
      setTimeout(() => setCopiedPath(null), 1600);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedPath(key);
      setTimeout(() => setCopiedPath(null), 1600);
    }
  };

  const copyAll = async () => {
    const text = PATHS.map((p) => `${origin}${p.path}`).join('\n');
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1600);
  };

  return (
    <div className="flex-1 p-5 sm:p-8 space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 rounded-2xl flex items-center justify-center">
              <ShieldCheck className="text-indigo-400 w-5 h-5" />
            </div>
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">App Verification</h2>
              <p className="text-zinc-400 mt-1 text-sm">Public URLs for Google & Facebook app review.</p>
            </div>
          </div>
        </div>
        <button
          onClick={copyAll}
          className="inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold px-4 py-2.5 rounded-xl shadow-lg shadow-indigo-500/20 transition self-start"
        >
          {copiedAll ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copiedAll ? 'Copied' : 'Copy All URLs'}
        </button>
      </header>

      <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-2xl p-4 sm:p-5 text-sm text-indigo-200/80">
        Use the links below when submitting your app for verification with Google or Facebook. Each URL is publicly accessible and reflects your current deployed domain.
      </div>

      <div className="grid grid-cols-1 gap-3">
        {PATHS.map((p) => {
          const fullUrl = origin ? `${origin}${p.path}` : p.path;
          const isCopied = copiedPath === p.path;
          return (
            <div
              key={p.path}
              className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-lg shadow-black/20"
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white font-bold text-sm sm:text-base">{p.label}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{p.desc}</p>
                  </div>
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded-md">
                    Public
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <a
                    href={fullUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex-1 min-w-0 flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-3 text-xs sm:text-sm font-mono text-zinc-300 hover:text-indigo-300 hover:border-indigo-500/40 transition group"
                    title={fullUrl}
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0 text-zinc-600 group-hover:text-indigo-400" />
                    <span className="truncate">{fullUrl}</span>
                  </a>
                  <button
                    onClick={() => copy(fullUrl, p.path)}
                    className={`shrink-0 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold transition ${
                      isCopied
                        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        : 'bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700'
                    }`}
                  >
                    {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {isCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AppVerification;
