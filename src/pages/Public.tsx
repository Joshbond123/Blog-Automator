import React, { useState } from 'react';
import { Zap, Mail, Phone, Lock, ArrowRight, Shield, FileText, Trash2, Info, MessageCircle, Menu, X, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { navigate } from '../router';

const PUBLIC_NAV = [
  { path: '/', label: 'Home' },
  { path: '/about', label: 'About' },
  { path: '/privacy-policy', label: 'Privacy' },
  { path: '/terms', label: 'Terms' },
  { path: '/contact', label: 'Contact' },
  { path: '/data-deletion', label: 'Data Deletion' },
];

const PublicHeader = ({ currentPath }: { currentPath: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 backdrop-blur-xl bg-black/70 border-b border-zinc-900">
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between">
        <button onClick={() => navigate('/')} className="flex items-center gap-3 group">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30 group-hover:scale-105 transition">
            <Zap className="text-white w-5 h-5 fill-white/20" />
          </div>
          <div className="text-left">
            <p className="font-black text-white tracking-tight leading-none">BLOG</p>
            <p className="text-[9px] font-bold text-indigo-500 tracking-[0.2em] uppercase mt-0.5">Automator</p>
          </div>
        </button>
        <nav className="hidden md:flex items-center gap-1">
          {PUBLIC_NAV.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`px-3.5 py-2 rounded-lg text-sm font-semibold transition ${
                currentPath === item.path ? 'text-white bg-zinc-900' : 'text-zinc-400 hover:text-white hover:bg-zinc-900/60'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button onClick={() => setOpen(!open)} className="md:hidden p-2 text-zinc-300">
          {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>
      {open && (
        <div className="md:hidden border-t border-zinc-900 bg-black">
          <div className="px-5 py-3 flex flex-col">
            {PUBLIC_NAV.map((item) => (
              <button
                key={item.path}
                onClick={() => { navigate(item.path); setOpen(false); }}
                className={`text-left px-3 py-3 rounded-lg text-sm font-semibold ${
                  currentPath === item.path ? 'text-white bg-zinc-900' : 'text-zinc-400'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
};

const PublicFooter = () => (
  <footer className="border-t border-zinc-900 mt-20">
    <div className="max-w-6xl mx-auto px-5 sm:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-lg flex items-center justify-center">
          <Zap className="text-white w-4 h-4" />
        </div>
        <p className="text-sm text-zinc-500">© {new Date().getFullYear()} Blog Automator. All rights reserved.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        {PUBLIC_NAV.slice(1).map((item) => (
          <button key={item.path} onClick={() => navigate(item.path)} className="text-xs text-zinc-500 hover:text-white transition">
            {item.label}
          </button>
        ))}
      </div>
    </div>
  </footer>
);

const PageShell = ({ currentPath, children }: { currentPath: string; children: React.ReactNode }) => (
  <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-indigo-500/30 flex flex-col">
    <PublicHeader currentPath={currentPath} />
    <main className="flex-1">{children}</main>
    <PublicFooter />
  </div>
);

// ---------- HOME / LOGIN ----------
export const HomePage = ({ onLogin }: { onLogin: (password: string) => boolean }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setTimeout(() => {
      const ok = onLogin(password);
      if (!ok) setError('Incorrect password. Please try again.');
      setLoading(false);
    }, 250);
  };

  return (
    <PageShell currentPath="/">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_55%)] pointer-events-none" />
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-12 lg:py-20 grid lg:grid-cols-2 gap-12 items-center">
          {/* Brand / pitch */}
          <div className="space-y-7">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-bold tracking-wider uppercase">
                <Zap className="w-3.5 h-3.5" /> AI Content Automation
              </span>
              <h1 className="mt-5 text-4xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-[1.05]">
                Automate Your <span className="bg-gradient-to-r from-indigo-400 to-violet-500 bg-clip-text text-transparent">Blog & Video</span> Publishing
              </h1>
              <p className="mt-5 text-zinc-400 text-base sm:text-lg leading-relaxed max-w-xl">
                Generate, schedule, and publish AI-powered blog posts and videos to Google Blogger and Facebook from one streamlined dashboard.
              </p>
            </motion.div>

            <ul className="grid sm:grid-cols-2 gap-3 max-w-xl">
              {['AI-generated content', 'Multi-account scheduling', 'Blogger & Facebook publishing', 'Encrypted credential storage'].map((f) => (
                <li key={f} className="flex items-center gap-2.5 text-sm text-zinc-300">
                  <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center"><Check className="w-3 h-3" /></span>
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Login card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="w-full max-w-md justify-self-center lg:justify-self-end"
          >
            <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-7 sm:p-9 shadow-2xl shadow-black/40">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/30">
                  <Lock className="text-white w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Dashboard Access</h2>
                  <p className="text-xs text-zinc-500">Enter your password to continue</p>
                </div>
              </div>

              <form onSubmit={submit} className="space-y-5">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider ml-1">Password</label>
                  <div className="relative group">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within:text-indigo-500 transition" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoFocus
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl pl-11 pr-4 py-3.5 text-white focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition"
                    />
                  </div>
                </div>

                {error && (
                  <div className="text-xs font-semibold text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2.5">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading || !password}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 transition shadow-lg shadow-indigo-500/20"
                >
                  {loading ? 'Verifying…' : (<>Sign In <ArrowRight className="w-4 h-4" /></>)}
                </button>
              </form>

              <p className="mt-6 text-center text-[11px] text-zinc-600">
                Protected by secure local authentication
              </p>
            </div>
          </motion.div>
        </div>
      </section>
    </PageShell>
  );
};

// ---------- Generic content page wrapper ----------
const ContentPage = ({ currentPath, icon: Icon, title, subtitle, children }: any) => (
  <PageShell currentPath={currentPath}>
    <section className="max-w-4xl mx-auto px-5 sm:px-8 py-12 lg:py-16">
      <div className="flex items-start gap-4 mb-10">
        <div className="w-14 h-14 shrink-0 bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 rounded-2xl flex items-center justify-center">
          <Icon className="text-indigo-400 w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">{title}</h1>
          <p className="text-zinc-400 mt-2">{subtitle}</p>
        </div>
      </div>
      <div className="prose prose-invert max-w-none space-y-6 text-zinc-300 leading-relaxed">
        {children}
      </div>
    </section>
  </PageShell>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="text-xl sm:text-2xl font-bold text-white mt-8 mb-3">{children}</h2>
);

// ---------- ABOUT ----------
export const AboutPage = () => (
  <ContentPage currentPath="/about" icon={Info} title="About Blog Automator" subtitle="Smarter content publishing for creators, marketers, and small teams.">
    <p>Blog Automator is a content automation platform that helps creators and businesses generate, schedule, and publish blog posts and short videos powered by modern AI. We integrate directly with Google Blogger and Facebook Pages so your content goes live without manual copy-paste work.</p>
    <SectionTitle>Our Mission</SectionTitle>
    <p>We believe content creation should be effortless. Our mission is to give every creator the ability to publish high-quality, consistent content across multiple channels — without spending hours every day on manual workflows.</p>
    <SectionTitle>What We Do</SectionTitle>
    <ul className="list-disc list-inside space-y-2">
      <li>AI-driven blog and video script generation</li>
      <li>Automatic publishing to Google Blogger and Facebook</li>
      <li>Smart scheduling across multiple accounts and niches</li>
      <li>Encrypted credential storage and secure account management</li>
    </ul>
    <SectionTitle>Contact</SectionTitle>
    <p>Have a question or partnership idea? Reach out via the <button onClick={() => navigate('/contact')} className="text-indigo-400 hover:underline">contact page</button>.</p>
  </ContentPage>
);

// ---------- PRIVACY ----------
export const PrivacyPage = () => (
  <ContentPage currentPath="/privacy-policy" icon={Shield} title="Privacy Policy" subtitle={`Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}>
    <p>Your privacy matters to us. This Privacy Policy explains how Blog Automator ("we", "us", or "our") collects, uses, and protects your information when you use our service.</p>
    <SectionTitle>Information We Collect</SectionTitle>
    <ul className="list-disc list-inside space-y-2">
      <li><strong className="text-white">Account credentials</strong> you connect (Blogger, Facebook, AI providers) — stored encrypted at rest.</li>
      <li><strong className="text-white">Content metadata</strong> you generate (post titles, schedules, status).</li>
      <li><strong className="text-white">Technical data</strong> such as logs and error reports for service reliability.</li>
    </ul>
    <SectionTitle>How We Use Your Information</SectionTitle>
    <ul className="list-disc list-inside space-y-2">
      <li>To generate and publish content on your behalf to platforms you authorize.</li>
      <li>To operate, secure, and improve the service.</li>
      <li>To respond to support requests and notify you of important changes.</li>
    </ul>
    <SectionTitle>Third-Party Services</SectionTitle>
    <p>We integrate with Google (Blogger), Meta (Facebook), and various AI providers. Their handling of data is governed by their own privacy policies.</p>
    <SectionTitle>Data Security</SectionTitle>
    <p>All sensitive credentials are encrypted using AES-256-GCM. Data is transmitted over HTTPS. Access to production systems is restricted.</p>
    <SectionTitle>Your Rights</SectionTitle>
    <p>You may request access to, correction of, or deletion of your data at any time. See our <button onClick={() => navigate('/data-deletion')} className="text-indigo-400 hover:underline">data deletion page</button>.</p>
    <SectionTitle>Contact</SectionTitle>
    <p>Email <a className="text-indigo-400 hover:underline" href="mailto:adeniranj787@gmail.com">adeniranj787@gmail.com</a> for any privacy-related questions.</p>
  </ContentPage>
);

// ---------- TERMS ----------
export const TermsPage = () => (
  <ContentPage currentPath="/terms" icon={FileText} title="Terms of Service" subtitle={`Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}>
    <p>By accessing or using Blog Automator, you agree to be bound by these Terms of Service. Please read them carefully.</p>
    <SectionTitle>Use of Service</SectionTitle>
    <p>You may use the service only for lawful purposes and in accordance with these Terms. You are responsible for the content you publish through the service.</p>
    <SectionTitle>Account Responsibilities</SectionTitle>
    <ul className="list-disc list-inside space-y-2">
      <li>You are responsible for maintaining the security of your dashboard password and connected accounts.</li>
      <li>You must comply with the terms of any third-party platforms you connect (Google, Facebook, etc.).</li>
      <li>You may not use the service to publish illegal, harmful, or misleading content.</li>
    </ul>
    <SectionTitle>Intellectual Property</SectionTitle>
    <p>You retain ownership of all content you create. You grant us a limited license to process and publish that content on your behalf to the platforms you authorize.</p>
    <SectionTitle>Service Availability</SectionTitle>
    <p>We strive for high availability but do not guarantee uninterrupted service. We may modify, suspend, or discontinue features at any time.</p>
    <SectionTitle>Limitation of Liability</SectionTitle>
    <p>The service is provided "as is" without warranties of any kind. We are not liable for any indirect, incidental, or consequential damages arising from your use of the service.</p>
    <SectionTitle>Changes</SectionTitle>
    <p>We may update these Terms from time to time. Continued use of the service after changes constitutes acceptance of the new Terms.</p>
    <SectionTitle>Contact</SectionTitle>
    <p>Questions about these Terms? Email <a className="text-indigo-400 hover:underline" href="mailto:adeniranj787@gmail.com">adeniranj787@gmail.com</a>.</p>
  </ContentPage>
);

// ---------- CONTACT ----------
export const ContactPage = () => {
  const cards = [
    {
      icon: Mail,
      label: 'Email Support',
      value: 'adeniranj787@gmail.com',
      href: 'mailto:adeniranj787@gmail.com',
      hint: 'We typically respond within 24 hours.',
    },
    {
      icon: Phone,
      label: 'Phone Support',
      value: '+234 803 686 9577',
      href: 'tel:+2348036869577',
      hint: 'Available Mon–Fri, 9 AM – 6 PM (WAT).',
    },
  ];
  return (
    <PageShell currentPath="/contact">
      <section className="max-w-5xl mx-auto px-5 sm:px-8 py-12 lg:py-16">
        <div className="text-center mb-12 max-w-2xl mx-auto">
          <div className="inline-flex w-14 h-14 mb-5 bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/20 rounded-2xl items-center justify-center">
            <MessageCircle className="text-indigo-400 w-6 h-6" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">Get in Touch</h1>
          <p className="text-zinc-400 mt-3">Have a question, bug report, or partnership idea? We'd love to hear from you.</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          {cards.map((c) => (
            <a
              key={c.label}
              href={c.href}
              className="group block bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 hover:border-indigo-500/40 rounded-3xl p-7 transition shadow-xl shadow-black/30"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 shrink-0 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl flex items-center justify-center group-hover:bg-indigo-500/20 transition">
                  <c.icon className="w-5 h-5 text-indigo-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider">{c.label}</p>
                  <p className="text-white font-bold text-lg mt-1 break-all group-hover:text-indigo-400 transition">{c.value}</p>
                  <p className="text-xs text-zinc-500 mt-2">{c.hint}</p>
                </div>
              </div>
            </a>
          ))}
        </div>

        <div className="mt-10 bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-800 rounded-3xl p-7 sm:p-9 text-center">
          <h2 className="text-xl font-bold text-white">Need help fast?</h2>
          <p className="text-zinc-400 mt-2 text-sm">Email is the fastest way to reach our support team. Please include as much detail as possible about your issue.</p>
          <a href="mailto:adeniranj787@gmail.com" className="inline-flex items-center gap-2 mt-5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-6 py-3 rounded-2xl transition shadow-lg shadow-indigo-500/20">
            <Mail className="w-4 h-4" /> Email Support
          </a>
        </div>
      </section>
    </PageShell>
  );
};

// ---------- DATA DELETION ----------
export const DataDeletionPage = () => (
  <ContentPage currentPath="/data-deletion" icon={Trash2} title="Data Deletion Request" subtitle="Request the removal of your data from Blog Automator at any time.">
    <p>We respect your right to control your personal data. If you would like to delete your account, connected credentials, or generated content from our systems, follow the steps below.</p>
    <SectionTitle>How to Request Deletion</SectionTitle>
    <ol className="list-decimal list-inside space-y-2">
      <li>Send an email to <a className="text-indigo-400 hover:underline" href="mailto:adeniranj787@gmail.com">adeniranj787@gmail.com</a> with the subject line <strong className="text-white">"Data Deletion Request"</strong>.</li>
      <li>Include the email address and any account identifiers associated with your usage.</li>
      <li>Specify whether you want to delete <em>all data</em> or only specific items (e.g. connected Facebook page, scheduled posts).</li>
    </ol>
    <SectionTitle>What Gets Deleted</SectionTitle>
    <ul className="list-disc list-inside space-y-2">
      <li>Connected account credentials (Blogger, Facebook, AI providers).</li>
      <li>Stored schedules, generated posts, and uploaded media references.</li>
      <li>Application settings and personal preferences.</li>
    </ul>
    <SectionTitle>Processing Time</SectionTitle>
    <p>We will process verified deletion requests within <strong className="text-white">7 business days</strong> and send you a confirmation once complete. Some technical logs may be retained for a limited time as required by law.</p>
    <SectionTitle>Facebook Users</SectionTitle>
    <p>If you connected via Facebook and wish to revoke our access, you can do so directly from your Facebook settings under <em>Settings → Apps and Websites</em>, then email us to confirm full deletion of any cached data.</p>
    <SectionTitle>Need Help?</SectionTitle>
    <p>For questions about deletion or data handling, email <a className="text-indigo-400 hover:underline" href="mailto:adeniranj787@gmail.com">adeniranj787@gmail.com</a> or call <a className="text-indigo-400 hover:underline" href="tel:+2348036869577">+234 803 686 9577</a>.</p>
  </ContentPage>
);
