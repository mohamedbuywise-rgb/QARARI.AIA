import { useState, useRef, useMemo, useEffect } from "react";
import { useApp } from "@/lib/AppContext";
import { getCategoryIcon } from "@/lib/categoryIcons";
import { currencies, FREE_MONTHLY_LIMIT } from "@/lib/types";
import { getDemoReport } from "@/lib/analysisEngine";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TypingText } from "@/components/TypingText";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Sparkles, Camera, Upload, X, Crown, GitCompare, MessageCircle, Brain, RefreshCw } from "lucide-react";

export function InputScreen() {
  const { t, lang, navigate, setCurrentReport, isPremium, session, showToast, history, saveToHistory } = useApp();
  const [product, setProduct] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("EGP");
  const [notes, setNotes] = useState("");
  const [purpose, setPurpose] = useState("personal");
  const [duration, setDuration] = useState("oneToTwoYears");
  const [specs, setSpecs] = useState("");
  const [condition, setCondition] = useState("new");
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [maxScans, setMaxScans] = useState<number>(FREE_MONTHLY_LIMIT);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const Icon = useMemo(() => getCategoryIcon(product), [product]);

  const quotaExceeded = remaining !== null && remaining <= 0;

  useEffect(() => {
    async function fetchRemaining() {
      try {
        const headers: Record<string, string> = {};
        if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
        const res = await fetch("/api/scans-remaining", { headers });
        const data = await res.json();
        setRemaining(data.unlimited ? null : data.remaining);
        if (typeof data.max === "number") setMaxScans(data.max);
      } catch {
        setRemaining(null);
      }
    }
    fetchRemaining();
  }, [session, isPremium]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => setPhoto(reader.result as string);
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };

  const handleSubmit = async () => {
    if (!product.trim() || !price.trim()) {
      showToast(lang === "ar" ? "اكتب اسم المنتج والسعر" : "Enter product name and price");
      return;
    }
    if (quotaExceeded) {
      navigate("upgrade");
      return;
    }
    setLoading(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

      let imageBase64: { data: string; mimeType: string } | undefined;
      if (photo) {
        const [meta, data] = photo.split(",");
        const mimeType = meta.match(/data:(.*);base64/)?.[1] || "image/jpeg";
        imageBase64 = { data, mimeType };
      }

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify({
          product: product.trim(),
          offeredPrice: parseFloat(price),
          currency,
          notes: notes.trim(),
          purpose,
          duration,
          specs: specs.trim(),
          condition,
          language: lang,
          imageBase64,
        }),
      });

      if (res.status === 403) {
        setRemaining(0);
        navigate("upgrade");
        return;
      }

      if (!res.ok) {
        showToast(t("analysisError") || (lang === "ar" ? "حدث خطأ، حاول مرة أخرى" : "Something went wrong, please retry"));
        return;
      }

      const result = await res.json();
      setCurrentReport(result);
      setRemaining((r) => (r !== null ? Math.max(0, r - 1) : r));
      navigate("report");
    } catch {
      showToast(lang === "ar" ? "تعذر الاتصال بالخادم" : "Couldn't reach the server");
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = () => {
    setCurrentReport(getDemoReport());
    navigate("report");
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 slide-up">
      {/* Hero */}
      <div className="mb-6 text-center">
        <div className="relative mb-3 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl shadow-amber-500/30">
          <div className="absolute inset-0 animate-pulse rounded-2xl bg-amber-400/20 blur-lg" />
          <Sparkles className="relative h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h1 className="font-serif text-3xl font-bold text-amber-400">{t("appName")}</h1>
        <div className="mt-1 h-5">
          <TypingText
            phrases={
              lang === "ar"
                ? ["حلل قرارك قبل ما تدفع 💸", "اعرف السعر العادل في السوق المصري 🇪🇬", "وفر فلوسك واشتري بذكاء 🧠"]
                : ["Analyze before you pay 💸", "Know the fair market price 🇪🇬", "Save money, buy smart 🧠"]
            }
            className="text-sm text-zinc-400"
          />
        </div>
      </div>

      {/* Form Card */}
      <div className="card-hover rounded-2xl border border-amber-500/15 bg-gradient-to-b from-zinc-900/80 to-[#0B0B0F] p-6 shadow-2xl backdrop-blur-sm">
        <div className="space-y-5">
          {/* Product Name with Live Icon */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("productName")}</Label>
            <div className="flex items-center gap-3">
              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-zinc-800 via-zinc-900 to-black shadow-md ring-1 ring-amber-500/20">
                <div className="absolute inset-0 bg-gradient-to-tr from-amber-500/10 via-transparent to-transparent" />
                <Icon className="relative h-6 w-6 text-amber-400/90" strokeWidth={1.5} />
              </div>
              <Input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder={t("productNamePlaceholder")}
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 transition-all"
              />
            </div>
          </div>

          {/* Price + Currency */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("offeredPrice")}</Label>
              <Input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
                className="border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("currency")}</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  {currencies.map((c) => (
                    <SelectItem key={c.code} value={c.code} className="focus:bg-amber-500/20 focus:text-amber-400">
                      {lang === "ar" ? `${c.arName} (${c.arShort})` : `${c.enName} (${c.enShort})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Usage Profile */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("purposeOfUse")}</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  <SelectItem value="personal" className="focus:bg-amber-500/20 focus:text-amber-400">{t("personal")}</SelectItem>
                  <SelectItem value="gift" className="focus:bg-amber-500/20 focus:text-amber-400">{t("gift")}</SelectItem>
                  <SelectItem value="work" className="focus:bg-amber-500/20 focus:text-amber-400">{t("work")}</SelectItem>
                  <SelectItem value="gaming" className="focus:bg-amber-500/20 focus:text-amber-400">{t("gaming")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-zinc-300">{t("expectedDuration")}</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                  <SelectItem value="lessThanYear" className="focus:bg-amber-500/20 focus:text-amber-400">{t("lessThanYear")}</SelectItem>
                  <SelectItem value="oneToTwoYears" className="focus:bg-amber-500/20 focus:text-amber-400">{t("oneToTwoYears")}</SelectItem>
                  <SelectItem value="threePlusYears" className="focus:bg-amber-500/20 focus:text-amber-400">{t("threePlusYears")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Product Condition */}
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-zinc-300">{t("productCondition")}</Label>
            <Select value={condition} onValueChange={setCondition}>
              <SelectTrigger className="border-zinc-700 bg-zinc-800/50 text-zinc-100 focus:border-amber-500/50 transition-all">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-700 bg-zinc-800 text-zinc-100">
                <SelectItem value="new" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionNew")}</SelectItem>
                <SelectItem value="likeNew" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionLikeNew")}</SelectItem>
                <SelectItem value="used" className="focus:bg-amber-500/20 focus:text-amber-400">{t("conditionUsed")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Photo Upload */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-zinc-300">{t("uploadPhoto")}</Label>
            <div className="flex gap-2">
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileSelect} className="hidden" />
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 transition-all"
              >
                <Upload className="h-4 w-4" /> {t("uploadPhoto")}
              </Button>
              <Button
                onClick={() => cameraInputRef.current?.click()}
                variant="outline"
                className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-amber-400 transition-all"
              >
                <Camera className="h-4 w-4" /> {t("takePhoto")}
              </Button>
            </div>
            {photo && (
              <div className="relative inline-block mt-2">
                <img src={photo} alt="product" className="h-20 w-20 rounded-lg border border-amber-500/40 object-cover shadow-lg shadow-amber-500/10" />
                <button
                  onClick={() => setPhoto(null)}
                  className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow-lg hover:bg-red-600 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <p className="text-xs text-zinc-500">{t("photoHelper")}</p>
          </div>

          {/* Scan Counter */}
          <div className="text-center text-sm py-1">
            {remaining === null ? (
              <span className="text-zinc-600 animate-pulse">…</span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-0.5 text-xs font-bold ${isPremium ? "bg-amber-400/10 text-amber-400 ring-1 ring-amber-400/20" : "bg-zinc-800 text-zinc-400"}`}>
                {isPremium && <Crown className="h-3 w-3" />}
                {t("scansLeft", { remaining, max: maxScans })}
              </span>
            )}
          </div>

          {/* Submit */}
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className={`cta-glow w-full bg-gradient-to-r from-amber-400 to-amber-600 text-[#0B0B0F] font-bold hover:from-amber-300 hover:to-amber-500 disabled:opacity-50 h-12 text-lg shadow-xl shadow-amber-500/20 transition-all duration-300 ${loading ? 'scale-95' : 'hover:scale-[1.02]'}`}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5 animate-spin" />
                {lang === "ar" ? "جاري تحليل القرار..." : "Analyzing Decision..."}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Brain className="h-5 w-5" />
                {t("analyzeButton")}
              </span>
            )}
          </Button>

          {!isPremium && (
            <button
              onClick={() => navigate("upgrade")}
              className="group flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 py-3 text-sm font-bold text-amber-400 transition-all hover:bg-amber-500/10"
            >
              <Crown className="h-4 w-4 transition-transform group-hover:rotate-12" />
              {lang === "ar" ? "احصل على تحليلات غير محدودة" : "Get Unlimited Analytics"}
            </button>
          )}
        </div>
      </div>

      {/* Demo Section */}
      <div className="mt-8 text-center">
        <p className="text-xs text-zinc-500 mb-3">{lang === "ar" ? "مش متأكد؟ جرب التقرير الديمو" : "Not sure? Try a demo report"}</p>
        <button
          onClick={handleDemo}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-800/50 px-4 py-2 text-xs font-medium text-zinc-400 transition-all hover:bg-zinc-800 hover:text-amber-400"
        >
          <RefreshCw className="h-3 w-3" /> {t("tryDemo")}
        </button>
      </div>
    </div>
  );
}
