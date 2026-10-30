"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import Dashboard from "./dashboard";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "../lib/supabase";

export default function AuthGate() {
  const configured = useMemo(() => isSupabaseConfigured(), []);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(configured);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabaseBrowserClient();
    let mounted = true;
    supabase.auth.getUser().then(({ data }) => {
      if (mounted) { setUser(data.user ?? null); setChecking(false); }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) { setUser(session?.user ?? null); setChecking(false); }
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, [configured]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setMessage(""); setBusy(true);
    try {
      const supabase = getSupabaseBrowserClient();
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) setMessage("Confirmation email sent. Confirm it, then sign in.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Authentication failed.");
    } finally { setBusy(false); }
  };

  if (!configured) return <SetupScreen />;
  if (checking) return <div className="auth-loading">Connecting to your portfolio…<AuthStyles /></div>;
  if (user) return <Dashboard user={user} />;

  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><span>S</span><div><strong>Stock Asset Portfolio</strong><small>Cloud Sync</small></div></div>
    <div className="auth-copy"><span>{mode === "login" ? "WELCOME BACK" : "CREATE ACCOUNT"}</span><h1>{mode === "login" ? "Sign in" : "Sign up"}</h1><p>Use the same account on your computer and phone to keep your portfolio synchronized.</p></div>
    <form onSubmit={submit}><label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label><label>Password<input type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>{message && <p className="auth-message">{message}</p>}<button disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button></form>
    <button className="auth-switch" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMessage(""); }}>{mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}</button>
  </section><AuthStyles /></main>;
}

function SetupScreen() {
  return <main className="auth-shell"><section className="auth-card setup-card"><div className="auth-brand"><span>S</span><div><strong>Stock Asset Portfolio</strong><small>Setup required</small></div></div><h1>Connect Supabase</h1><p>Create <b>.env.local</b> in this project folder and enter your Supabase values.</p><pre>{`NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLISHABLE-KEY`}</pre><p>Then restart with <b>npm run dev</b>.</p></section><AuthStyles /></main>;
}

function AuthStyles() {
  return <style jsx global>{`.auth-shell,.auth-loading{min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f7fb;color:#172033;font-family:Arial,sans-serif}.auth-loading{font-weight:700}.auth-card{width:min(430px,100%);padding:34px;background:#fff;border:1px solid #e3e9f2;border-radius:22px;box-shadow:0 24px 70px rgba(20,31,50,.12)}.auth-brand{display:flex;align-items:center;gap:12px;margin-bottom:34px}.auth-brand>span{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:#111827;color:#fff;font-weight:900}.auth-brand div{display:flex;flex-direction:column}.auth-brand strong{font-size:14px}.auth-brand small{margin-top:3px;color:#8490a5;font-size:11px}.auth-copy>span{color:#7c3aed;font-size:10px;font-weight:900;letter-spacing:.14em}.auth-copy h1,.setup-card h1{margin:8px 0;font-size:30px}.auth-copy p,.setup-card p{color:#69758a;font-size:13px;line-height:1.65}.auth-card form{display:grid;gap:16px;margin-top:24px}.auth-card label{display:grid;gap:7px;color:#334155;font-size:12px;font-weight:800}.auth-card input{height:46px;padding:0 13px;border:1px solid #d7dfeb;border-radius:11px;font:inherit;font-size:14px;outline:none}.auth-card input:focus{border-color:#7c3aed;box-shadow:0 0 0 3px rgba(124,58,237,.1)}.auth-card form>button{height:48px;border:0;border-radius:11px;background:#111827;color:#fff;font-weight:850;cursor:pointer}.auth-card form>button:disabled{opacity:.55}.auth-switch{width:100%;margin-top:18px;border:0;background:transparent;color:#6d28d9;font-size:12px;font-weight:800;cursor:pointer}.auth-message{margin:0;padding:10px 12px;border-radius:9px;background:#f1f5f9;color:#475569!important;font-size:12px!important}.setup-card pre{overflow:auto;padding:14px;border-radius:11px;background:#111827;color:#e5e7eb;font-size:11px;line-height:1.6}`}</style>;
}
