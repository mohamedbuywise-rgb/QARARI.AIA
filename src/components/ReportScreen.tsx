import { useState, useRef, useMemo, useEffect } from "react";
import { FutureValueCard } from "@/components/FutureValueCard";
import { ConfettiCelebration } from "@/components/ConfettiCelebration";
import { ScoreRing } from "@/components/ScoreRing";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { getCategoryIcon } from "@/lib/categoryIcons";
import { currencies } from "@/lib/types";
import type { Verdict } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Info, TrendingUp, TrendingDown, AlertTriangle, Check, X, Compass,
  Shield, Lightbulb, Copy, Share2, Bookmark, Bell,
  ThumbsUp, ThumbsDown, MessageCircle, Mic, Send,
  Sparkles, GitCompare, Crown, Users, RefreshCw, DollarSign,
} from "lucide-react";

export function ReportScreen() {
  const { t, lang, dir, currentReport, navigate, saveToHistory, history, user, session, showToast, isPremium, requireAuth } = useApp();
  const [showConfetti, setShowConfetti] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [feedbackGiven, setFeedbackGiven] = useState<"up" | "down" | null>(null);
  const [showFeedbackBox, setShowFeedbackBox] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRemaining, setChatRemaining] = useState(20);
  const [chatLimitHit, setChatLimitHit] = useState(false);
  const [listening, setListening] = useState(false);
  const [negVariant, setNegVariant] = useState<"polite" | "firm">("polite");
  const [showCompareInput, setShowCompareInput] = useState(false);
  const [compareProduct, setCompareProduct] = useState("");
  const recognitionRef = useRef<any>(null);

  const report = currentReport;
  if (!report) {
    navigate("input");
    return null;
  }

  // Mount animation
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Confetti on good deal
  useEffect(() => {
    if (report?.verdict === "good") {
      const timer = setTimeout(() => setShowConfetti(true), 400);
      return () => clearTimeout(timer);
    }
  }, [report?.verdict]);

  console.log("FULL AI RESPONSE:", report);

  const naLabel = lang === "ar" ? "غير متوفر" : "N/A";
  const fmtPrice = (n: unknown): string => (typeof n === "number" && !Number.isNaN(n) ? n.toLocaleString() : naLabel);
  const bilingualSafe = (bt: { ar?: string; en?: string } | null | undefined): string =>
    (lang === "ar" ? bt?.ar : bt?.en) ?? "";
  const bilingualArrSafe = (ba: { ar?: string[]; en?: string[] } | null | undefined): string[] =>
    (lang === "ar" ? ba?.ar : ba?.en) ?? [];

  const isExample = report.id.startsWith("demo-");
  const isSaved = history.some((h) => h.id === report.id);

  const currencyShort = (code: string) => {
    const c = currencies.find((c) => c.code === code);
    return lang === "ar" ? c?.arShort : c?.enShort;
  };
  const cShort = currencyShort(report.currency);

  const verdictConfig: Record<Verdict, { color: string; bg: string; border: string }> = {
    good: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
    fair: { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" },
    bad: { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" },
  };
  const vc = verdictConfig[report.verdict] ?? verdictConfig.fair;

  const ProductIcon = useMemo(() => getCategoryIcon(report.product), [report.product]);

  const handleSave = () => {
    requireAuth(async () => {
      await saveToHistory(report);
      showToast(t("saveToHistory") + " ✓");
    });
  };

  const handleShare = async () => {
    const summary = `${t("appName")} — ${report.product}\n${t(report.verdict === "good" ? "goodDeal" : report.verdict === "fair" ? "fairDeal" : "badDeal")}\n${t("offeredPrice")}: ${fmtPrice(report.offeredPrice)} ${cShort}\n${t("fairPriceRange")}: ${fmtPrice(report.marketFairPriceMin)}-${fmtPrice(report.marketFairPriceMax)} ${cShort}\n${t("potentialSavings")}: ${fmtPrice(report.moneySaved)} ${cShort}`;
    if (navigator.share) {
      try { await navigator.share({ text: summary, title: t("appName") }); } catch {}
    } else {
      navigator.clipboard.writeText(summary);
      showToast(t("copied"));
    }
  };

  const handleCopyNegotiation = () => {
    const text = bilingualSafe(report.negotiationScript);
    navigator.clipboard.writeText(text);
    showToast(t("copied"));
  };

  const handleWhatsAppShare = () => {
    const text = bilingualSafe(report.negotiationScript);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
  };

  const handleFeedback = (type: "up" | "down") => {
    if (type === "up") { setFeedbackGiven("up"); showToast(t("thanksFeedback")); }
    else { setFeedbackGiven("down"); setShowFeedbackBox(true); }
  };

  const submitFeedback = () => {
    setFeedbackGiven("down"); setShowFeedbackBox(false); showToast(t("thanksFeedback"));
  };

  const toggleListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showToast(lang === "ar" ? "المتصفح لا يدعم الإدخال الصوتي" : "Browser doesn't support voice input"); return; }
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.lang = lang === "ar" ? "ar-EG" : "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setChatInput((prev) => (prev ? prev + " " : "") + transcript);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    if (isExample) {
      setChatMessages((prev) => [...prev, { role: "user", content: chatInput }, { role: "assistant", content: t("chatDisabledExample") }]);
      setChatInput("");
      return;
    }
    if (!isPremium && (chatLimitHit || chatRemaining <= 0)) {
      setChatLimitHit(true);
      return;
    }
    const question = chatInput.trim();
    const outgoingHistory = [...chatMessages, { role: "user" as const, content: question }];
    setChatMessages(outgoingHistory);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          reportId: report.id,
          product: report.product,
          offeredPrice: report.offeredPrice,
          currency: report.currency,
          verdict: report.verdict,
          marketFairPriceMin: report.marketFairPriceMin,
          marketFairPriceMax: report.marketFairPriceMax,
          question,
          history: chatMessages.slice(-8),
          language: lang,
        }),
      });
      if (res.status === 403) {
        if (!isPremium) { setChatLimitHit(true); setChatRemaining(0); }
        setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatLimitReached") }]);
        return;
      }
      if (!res.ok) {
        setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatError") }]);
        return;
      }
      const data = await res.json();
      setChatMessages((prev) => [...prev, { role: "assistant", content: data.answer }]);
      if (!data.unlimited && typeof data.remaining === "number") {
        setChatRemaining(data.remaining);
        if (data.remaining <= 0) setChatLimitHit(true);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: t("chatError") }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleCompare = () => {
    if (!isPremium) { navigate("upgrade"); return; }
    if (!compareProduct.trim()) return;
    sessionStorage.setItem("qarari-compare-prefill-b", compareProduct.trim());
    setShowCompareInput(false);
    setCompareProduct("");
    navigate("compare");
  };

  const bilingual = (bt: { ar: string; en: string } | null | undefined) => bilingualSafe(bt);
  const bilingualArr = (ba: { ar: string[]; en: string[] } | null | undefined) => bilingualArrSafe(ba);

  return (
    <div
      className="mx-auto max-w-3xl px-4 py-6 pb-24"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? "translateY(0)" : "translateY(20px)",
        transition: "opacity 0.5s ease, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      {/* Confetti for good deals */}
      {showConfetti && (
        <ConfettiCelebration onDone={() => setShowConfetti(false)} />
      )}

      {isExample && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-400">
          <Sparkles className="h-4 w-4" /> {t("example")}
        </div>
      )}

      {/* Product Header */}
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black shadow-lg ring-1 ring-amber-500/20">
          <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 via-transparent to-transparent" />
          <ProductIcon className="relative h-10 w-10 text-amber-400/90" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-2xl font-bold text-amber-400">{report.product}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-zinc-800/60 px-2.5 py-1 text-sm text-zinc-300">
              {fmtPrice(report.offeredPrice)} {cShort}
            </span>
            <span className={`verdict-pop rounded-lg ${vc.bg} ${vc.border} border px-2.5 py-1 text-sm font-medium ${vc.color}`}>
              {t(report.verdict === "good" ? "goodDeal" : report.verdict === "fair" ? "fairDeal" : "badDeal")}
            </span>
            {typeof report.moneySaved === "number" && report.moneySaved > 0 && (
              <span className="verdict-pop rounded-lg bg-emerald-500/10 px-2.5 py-1 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/20" style={{ animationDelay: "0.15s" }}>
                {t("moneySaved")}: {fmtPrice(report.moneySaved)} {cShort}
              </span>
            )}
          </div>
        </div>
        {/* Score Ring */}
        {typeof report.overallScore === "number" && (
          <div className="shrink-0">
            <ScoreRing
              score={report.overallScore}
              size={80}
              label={lang === "ar" ? "التقييم" : "Score"}
            />
          </div>
        )}
      </div>

      {/* Market Overview */}
      <div className="card-hover mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Search className="h-5 w-5" /> {t("marketOverview")}
        </h2>
        <div className="flex items-center justify-between rounded-xl bg-zinc-800/40 p-4">
          <div className="text-center">
            <p className="text-xs text-zinc-500">{t("offeredPrice")}</p>
            <p className="mt-1 text-lg font-bold text-zinc-100">{fmtPrice(report.offeredPrice)}</p>
            <p className="text-xs text-zinc-500">{cShort}</p>
          </div>
          <div className="h-12 w-px bg-zinc-700" />
          <div className="text-center">
            <p className="text-xs text-zinc-500">{t("fairPriceRange")}</p>
            <p className="mt-1 text-lg font-bold text-amber-400">
              {report.marketFairPriceMin === null && report.marketFairPriceMax === null
                ? naLabel
                : `${fmtPrice(report.marketFairPriceMin)}–${fmtPrice(report.marketFairPriceMax)}`}
            </p>
            <p className="text-xs text-zinc-500">{cShort}</p>
          </div>
        </div>
        {bilingual(report.marketPriceSummary) && (
          <p className="mt-3 rounded-lg bg-zinc-800/30 p-3 text-sm leading-relaxed text-zinc-300">
            {bilingual(report.marketPriceSummary)}
          </p>
        )}
      </div>

      {/* Community Radar */}
      {report.communityInsights && report.communityInsights.analyzedCount >= 3 && (
        <div className="card-hover mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
          <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-emerald-400">
            <Users className="h-5 w-5" /> {t("communityInsightsTitle")}
          </h2>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="rounded-lg bg-zinc-800/40 p-3 text-center">
              <p className="text-2xl font-bold text-emerald-400">{report.communityInsights.analyzedCount}</p>
              <p className="text-xs text-zinc-400">{lang === "ar" ? "شخص حلّل المنتج ده" : "people analyzed this product"}</p>
            </div>
            <div className="rounded-lg bg-zinc-800/40 p-3 text-center">
              <p className="text-2xl font-bold text-amber-400">
                {report.communityInsights.recentPrices?.length
                  ? Math.round((report.communityInsights.recentPrices.reduce((a, b) => a + b, 0) / report.communityInsights.recentPrices.length) / report.offeredPrice * 100)
                  : naLabel}
                %
              </p>
              <p className="text-xs text-zinc-400">{lang === "ar" ? "سعر منتجك من متوسط السوق" : "Your price vs market avg"}</p>
            </div>
          </div>
          {(report.communityInsights.recentPrices ?? []).length > 1 && (
            <div className="border-t border-emerald-500/15 pt-3">
              <p className="mb-2 text-xs text-zinc-500">{t("communityRecentPrices")}</p>
              <div className="flex flex-wrap gap-2">
                {(report.communityInsights.recentPrices ?? []).map((p, i) => (
                  <span
                    key={i}
                    className={`rounded-lg px-2.5 py-1 text-sm ${
                      p === report.offeredPrice
                        ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30"
                        : p < report.offeredPrice
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {fmtPrice(p)} {cShort}
                    {p === report.offeredPrice && (lang === "ar" ? " (سعر انت)" : " (your price)")}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Final Verdict */}
      <div className="card-hover mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Info className="h-5 w-5" /> {t("finalVerdict")}
        </h2>
        <ol className={`space-y-2 ${dir === "rtl" ? "pr-5" : "pl-5"}`}>
          {bilingualArr(report.reasoningPoints).map((point, i) => (
            <li key={i} className="text-sm text-zinc-300">
              <span className="font-bold text-amber-400">{i + 1}.</span> {point}
            </li>
          ))}
        </ol>
        {isPremium && (
          <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500">
            <Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}
          </p>
        )}
      </div>

      {/* Before You Buy */}
      <div className={`mb-4 rounded-xl border ${report.verdict === "bad" ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"} p-4`}>
        <div className="flex items-start gap-2">
          <AlertTriangle className={`h-5 w-5 shrink-0 ${report.verdict === "bad" ? "text-red-400" : "text-amber-400"}`} />
          <div>
            <p className={`text-sm font-bold ${report.verdict === "bad" ? "text-red-400" : "text-amber-400"}`}>{t("beforeYouBuy")}</p>
            <p className="mt-1 text-sm text-zinc-300">{bilingual(report.preRecommendation)}</p>
          </div>
        </div>
      </div>

      {/* Future + Regret */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="card-hover rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-400">
            <TrendingUp className="h-4 w-4" /> {t("futureCompatibility")}
          </h3>
          <p className="text-sm text-zinc-300">{bilingual(report.futureCompatibility)}</p>
        </div>
        <div className="card-hover rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-400">
            <AlertTriangle className="h-4 w-4" /> {t("regretProbability")}
          </h3>
          <span className={`inline-block rounded-lg px-2.5 py-1 text-xs font-bold ${
            report.regretLevel === "low" ? "bg-emerald-500/10 text-emerald-400" :
            report.regretLevel === "medium" ? "bg-amber-500/10 text-amber-400" :
            "bg-red-500/10 text-red-400"
          }`}>
            {t(report.regretLevel ?? "medium")}
          </span>
          <p className="mt-2 text-sm text-zinc-300">{bilingual(report.regretJustification)}</p>
        </div>
      </div>

      {/* Future Value Card - Premium */}
      {report.resaleValue2Years && (
        <FutureValueCard
          lang={lang}
          offeredPrice={report.offeredPrice}
          resaleValue2Years={report.resaleValue2Years}
          resaleDepreciationRate={report.resaleDepreciationRate}
          currencyShort={cShort}
        />
      )}

      {/* Cons + Pros */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {dir === "rtl" ? (
          <>
            <div className="card-hover rounded-xl border border-red-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-red-400">
                <X className="h-4 w-4" /> {t("cons")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.cons).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <X className="h-4 w-4 shrink-0 text-red-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
            <div className="card-hover rounded-xl border border-emerald-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Check className="h-4 w-4" /> {t("pros")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.pros).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
          </>
        ) : (
          <>
            <div className="card-hover rounded-xl border border-emerald-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-400">
                <Check className="h-4 w-4" /> {t("pros")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.pros).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check className="h-4 w-4 shrink-0 text-emerald-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
            <div className="card-hover rounded-xl border border-red-500/15 bg-zinc-900/60 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-red-400">
                <X className="h-4 w-4" /> {t("cons")}
              </h3>
              <ul className="space-y-2">
                {bilingualArr(report.cons).map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                    <X className="h-4 w-4 shrink-0 text-red-400" /> {item}
                  </li>
                ))}
              </ul>
              {isPremium && <p className="mt-3 flex items-center gap-1 text-xs text-zinc-500"><Sparkles className="h-3 w-3" /> {t("expandedAnalysis")}</p>}
            </div>
          </>
        )}
      </div>

      {/* Better Alternatives + Compare Button */}
      <div className="mb-4">
        <h2 className="mb-3 flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
          <Compass className="h-5 w-5" /> {t("betterAlternatives")}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {bilingualArr(report.betterAlternatives).map((alt, i) => (
            <div key={i} className="card-hover flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-amber-500/30">
              <span className="text-sm font-medium text-zinc-100">{alt}</span>
              <button
                onClick={() => {
                  if (!isPremium) { navigate("upgrade"); return; }
                  setCompareProduct(alt);
                  setShowCompareInput(true);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500 hover:text-[#0B0B0F]"
              >
                <GitCompare className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Negotiation Script */}
      <div className="mb-4 rounded-xl border border-amber-500/15 bg-zinc-900/60 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-amber-400">
            <MessageCircle className="h-5 w-5" /> {t("negotiationScript")}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setNegVariant("polite")}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${negVariant === "polite" ? "bg-amber-500 text-[#0B0B0F]" : "bg-zinc-800 text-zinc-400"}`}
            >
              {lang === "ar" ? "هادي" : "Polite"}
            </button>
            <button
              onClick={() => setNegVariant("firm")}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${negVariant === "firm" ? "bg-amber-500 text-[#0B0B0F]" : "bg-zinc-800 text-zinc-400"}`}
            >
              {lang === "ar" ? "حازم" : "Firm"}
            </button>
          </div>
        </div>
        <div className="relative rounded-xl bg-zinc-950/50 p-4 pt-10">
          <div className="absolute top-3 flex gap-2 right-3">
            <button onClick={handleCopyNegotiation} className="text-zinc-500 hover:text-amber-400"><Copy className="h-4 w-4" /></button>
            <button onClick={handleWhatsAppShare} className="text-zinc-500 hover:text-emerald-400"><Share2 className="h-4 w-4" /></button>
          </div>
          <p className="text-sm italic leading-relaxed text-zinc-300">
            "{negVariant === "polite" ? bilingual(report.negotiationScript) : bilingual(report.negotiationScriptFirm)}"
          </p>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          onClick={handleSave}
          variant="outline"
          disabled={isSaved}
          className="border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400"
        >
          {isSaved ? <><Check className="h-4 w-4" /> {t("saved")}</> : <><Bookmark className="h-4 w-4" /> {t("saveToHistory")}</>}
        </Button>
        <Button
          onClick={handleShare}
          variant="outline"
          className="border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400"
        >
          <Share2 className="h-4 w-4" /> {t("shareReport")}
        </Button>
      </div>

      {/* AI Advisor Chat Toggle */}
      <div className="mt-8 flex flex-col items-center">
        <p className="mb-3 text-xs text-zinc-500">{t("chatAdvisorPromo")}</p>
        <Button
          onClick={() => setShowChat(true)}
          className="cta-glow rounded-full bg-gradient-to-r from-amber-400 to-amber-600 px-8 py-6 text-[#0B0B0F] font-bold shadow-xl shadow-amber-500/20 hover:scale-105 transition-transform"
        >
          <Bot className="h-5 w-5" /> {t("chatWithAdvisor")}
        </Button>
      </div>

      {/* Floating Chat Modal */}
      {showChat && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center">
          <div className="flex h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-amber-500/20 bg-zinc-900 shadow-2xl slide-up">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400 text-black shadow-lg shadow-amber-500/20">
                  <Bot className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-zinc-100">{t("chatWithAdvisor")}</h3>
                  <p className="text-[10px] text-emerald-400 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    {lang === "ar" ? "مساعدك الشخصي متصل" : "Your AI Advisor is online"}
                  </p>
                </div>
              </div>
              <button onClick={() => setShowChat(false)} className="rounded-full p-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"><X className="h-5 w-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
              {chatMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center opacity-50">
                  <Brain className="h-12 w-12 text-zinc-700 mb-2" />
                  <p className="text-xs text-zinc-500">{lang === "ar" ? "اسألني أي حاجة عن المنتج ده..." : "Ask me anything about this product..."}</p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-amber-500 text-[#0B0B0F] font-medium rounded-tr-none" : "bg-zinc-800 text-zinc-100 rounded-tl-none border border-zinc-700"}`}>
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-zinc-800 rounded-2xl rounded-tl-none px-4 py-2.5 flex gap-1">
                    <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce" />
                    <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="h-1.5 w-1.5 bg-amber-400 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 bg-zinc-900/50 border-t border-zinc-800">
              <div className="flex items-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-800 p-1.5 focus-within:border-amber-500/50 transition-colors">
                <Input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendChat()}
                  placeholder={t("chatInputPlaceholder")}
                  className="border-none bg-transparent text-sm focus-visible:ring-0"
                />
                <button onClick={toggleListening} className={`p-2 rounded-xl transition-colors ${listening ? "bg-red-500 text-white animate-pulse" : "text-zinc-500 hover:text-amber-400"}`}><Mic className="h-5 w-5" /></button>
                <button onClick={sendChat} disabled={!chatInput.trim() || chatLoading} className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400 text-black hover:bg-amber-300 disabled:opacity-40"><Send className="h-5 w-5" /></button>
              </div>
              <div className="mt-2 flex items-center justify-between px-1">
                {!isPremium && (
                  <p className={`text-[10px] font-bold ${chatRemaining <= 3 ? 'text-red-400' : 'text-zinc-500'}`}>
                    {lang === "ar" ? `باقي ${chatRemaining} رسائل` : `${chatRemaining} messages left`}
                  </p>
                )}
                {isPremium && <p className="text-[10px] text-amber-400 font-bold flex items-center gap-1"><Crown className="h-3 w-3" /> Premium Advisor</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
