import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Globe, History, User, Plus, GitCompare, HelpCircle, Bot, Zap } from "lucide-react";

export function Header() {
  const { lang, setLang, t, navigate, screen, isPremium, user } = useApp();

  return (
    <header className="sticky top-0 z-40 border-b border-amber-500/20 bg-[#0B0B0F]/95 backdrop-blur-md">
      {/* Subtle top glow line */}
      <div
        className="absolute top-0 left-0 right-0 h-[1px]"
        style={{
          background: "linear-gradient(90deg, transparent 0%, rgba(212,175,55,0.4) 30%, rgba(212,175,55,0.6) 50%, rgba(212,175,55,0.4) 70%, transparent 100%)",
        }}
      />

      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <button
          onClick={() => navigate("input")}
          className="flex items-center gap-2 transition-all duration-200 hover:opacity-90 hover:scale-[1.02]"
        >
          {/* Logo icon with glow */}
          <div className="relative">
            <div
              className="absolute inset-0 rounded-xl opacity-60"
              style={{
                background: "radial-gradient(circle, rgba(212,175,55,0.5) 0%, transparent 70%)",
                filter: "blur(6px)",
              }}
            />
            <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg shadow-amber-500/30">
              <Zap className="h-5 w-5 text-[#0B0B0F]" />
            </div>
          </div>
          <div className="flex flex-col items-start leading-none">
            <span className="gold-shimmer font-serif text-lg font-bold">Qarari</span>
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
            className={`group relative flex items-center gap-2 overflow-hidden rounded-full px-4 py-1.5 transition-all duration-200 ${
              screen === "advisor"
                ? "bg-amber-400 text-black shadow-lg shadow-amber-500/30"
                : "bg-zinc-900 text-amber-400 ring-1 ring-amber-500/30 hover:bg-zinc-800 hover:shadow-[0_0_12px_rgba(212,175,55,0.2)]"
            }`}
          >
            {/* Shimmer sweep on hover */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
            <Zap className={`h-4 w-4 ${screen === "advisor" ? "fill-black" : "animate-pulse"}`} />
            <span className="text-xs font-bold uppercase tracking-tight">
              {lang === "ar" ? "المساعد الذكي" : "AI Advisor"}
            </span>
            {isPremium && (
              <div className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            )}
          </button>

          <div className="mx-1 h-6 w-[1px] bg-zinc-800" />

          {[
            { screen: "input" as const, icon: <Plus className="h-5 w-5" />, title: t("newDecision") },
            { screen: "compare" as const, icon: <GitCompare className="h-5 w-5" />, title: t("compareProducts") },
            { screen: "history" as const, icon: <History className="h-5 w-5" />, title: t("history") },
          ].map((item) => (
            <button
              key={item.screen}
              onClick={() => navigate(item.screen)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-200 ${
                screen === item.screen
                  ? "bg-amber-500/15 text-amber-400 shadow-[0_0_8px_rgba(212,175,55,0.15)]"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400 hover:scale-110"
              }`}
              title={item.title}
            >
              {item.icon}
            </button>
          ))}

          <button
            onClick={() => navigate(user ? "profile" : "login")}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-200 ${
              screen === "profile" || screen === "login"
                ? "bg-amber-500/15 text-amber-400 shadow-[0_0_8px_rgba(212,175,55,0.15)]"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-amber-400 hover:scale-110"
            }`}
            title={t("profile")}
          >
            <User className="h-5 w-5" />
          </button>

          <button
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-zinc-400 transition-all duration-200 hover:bg-zinc-800/50 hover:text-amber-400 hover:scale-105"
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
