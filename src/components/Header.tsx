import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Globe, History, User, Sparkles, Plus, GitCompare, HelpCircle, Bot, Zap } from "lucide-react";

export function Header() {
  const { lang, setLang, t, navigate, screen, isPremium, user } = useApp();

  return (
    <header className="sticky top-0 z-40 border-b border-amber-500/20 bg-[#0B0B0F]/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <button
          onClick={() => navigate("input")}
          className="flex items-center gap-2 transition-opacity hover:opacity-80"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg shadow-amber-500/20">
            <Sparkles className="h-5 w-5 text-[#0B0B0F]" />
          </div>
          <div className="flex flex-col items-start leading-none">
            <span className="font-serif text-lg font-bold text-amber-400">Qarari</span>
            <span className="text-[10px] font-medium text-zinc-500">AI Analyzer</span>
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          {/* Premium AI Advisor Button */}
          <button
            onClick={() => {
              if (!user) {
                navigate("login");
              } else {
                navigate("advisor");
              }
            }}
            className={`group relative flex items-center gap-2 overflow-hidden rounded-full px-4 py-1.5 transition-all ${
              screen === "advisor" 
                ? "bg-amber-400 text-black shadow-lg shadow-amber-500/30" 
                : "bg-zinc-900 text-amber-400 ring-1 ring-amber-500/30 hover:bg-zinc-800"
            }`}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
            <Zap className={`h-4 w-4 ${screen === "advisor" ? "fill-black" : "animate-pulse"}`} />
            <span className="text-xs font-bold uppercase tracking-tight">
              {lang === "ar" ? "المساعد الذكي" : "AI Advisor"}
            </span>
            {isPremium && (
              <div className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            )}
          </button>

          <div className="mx-1 h-6 w-[1px] bg-zinc-800" />

          <button
            onClick={() => navigate("input")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "input" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("newDecision")}
          >
            <Plus className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate("compare")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "compare" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("compareProducts")}
          >
            <GitCompare className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate("history")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "history" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("history")}
          >
            <History className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate(user ? "profile" : "login")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
              screen === "profile" || screen === "login" ? "bg-amber-500/15 text-amber-400" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400"
            }`}
            title={t("profile")}
          >
            <User className="h-5 w-5" />
          </button>
          <button
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-amber-400"
            title={lang === "ar" ? "English" : "العربية"}
          >
            <Globe className="h-4 w-4" />
            <span className="text-xs font-bold">{lang === "ar" ? "EN" : "ع"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
