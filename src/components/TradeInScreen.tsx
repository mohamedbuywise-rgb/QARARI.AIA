import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronLeft, RefreshCw, Calculator, Smartphone, Laptop,
  Gamepad2, Headphones, Monitor, Watch, Camera, Tablet,
  Sparkles, ArrowRight, TrendingDown,
} from "lucide-react";
import { currencies } from "@/lib/types";

interface TradeInResult {
  device: string;
  category: string;
  condition: "excellent" | "good" | "fair" | "poor";
  estimatedTradeIn: number;
  estimatedResale: number;
  depreciationRate: string;
  suggestedNew: string;
  suggestedNewPrice: number;
  savingsAfterTradeIn: number;
}

const deviceCategories = [
  { id: "phone", label: "📱 موبايل", labelEn: "Phone", Icon: Smartphone },
  { id: "laptop", label: "💻 لابتوب", labelEn: "Laptop", Icon: Laptop },
  { id: "tablet", label: "📟 تابلت", labelEn: "Tablet", Icon: Tablet },
  { id: "watch", label: "⌚ ساعة ذكية", labelEn: "Smartwatch", Icon: Watch },
  { id: "headphones", label: "🎧 سماعات", labelEn: "Headphones", Icon: Headphones },
  { id: "console", label: "🎮 جهاز ألعاب", labelEn: "Gaming Console", Icon: Gamepad2 },
  { id: "tv", label: "📺 تلفاز", labelEn: "TV", Icon: Monitor },
  { id: "camera", label: "📷 كاميرا", labelEn: "Camera", Icon: Camera },
];

const conditionLabelsAr: Record<string, string> = {
  excellent: "ممتاز (بدون خدوش)",
  good: "جيد (خدوش بسيطة)",
  fair: "متوسط (خدوش واضحة)",
  poor: "ضعيف (عيوب واضحة)",
};
const conditionLabelsEn: Record<string, string> = {
  excellent: "Excellent (no scratches)",
  good: "Good (minor scratches)",
  fair: "Fair (visible scratches)",
  poor: "Poor (visible damage)",
};

// Trade-in value multipliers based on brand reputation & category
const brandMultipliers: Record<string, number> = {
  apple: 0.78,
  samsung: 0.58,
  sony: 0.55,
  lg: 0.45,
  xiaomi: 0.40,
  lenovo: 0.42,
  dell: 0.48,
  hp: 0.45,
  asus: 0.43,
  generic: 0.35,
};

const categoryMultipliers: Record<string, number> = {
  phone: 0.85,
  laptop: 0.75,
  tablet: 0.70,
  watch: 0.65,
  headphones: 0.60,
  console: 0.80,
  tv: 0.55,
  camera: 0.70,
};

const conditionMultipliers: Record<string, number> = {
  excellent: 1.0,
  good: 0.85,
  fair: 0.65,
  poor: 0.40,
};

function calculateTradeIn(device: string, category: string, condition: string, price: number): TradeInResult {
  const brand = device.toLowerCase();
  let brandMult = 0.35;
  for (const [key, val] of Object.entries(brandMultipliers)) {
    if (brand.includes(key)) { brandMult = val; break; }
  }
  const catMult = categoryMultipliers[category] || 0.60;
  const condMult = conditionMultipliers[condition] || 0.65;
  const baseTradeIn = Math.round(price * brandMult * catMult * condMult);
  const baseResale = Math.round(baseTradeIn * 1.25); // resale is ~25% higher than trade-in offer

  const depreciationRates: Record<string, string> = {
    phone: brand.includes("apple") ? "20% per year" : brand.includes("samsung") ? "30% per year" : "35% per year",
    laptop: "25% per year",
    tablet: "30% per year",
    watch: brand.includes("apple") ? "20% per year" : "30% per year",
    headphones: "35% per year",
    console: "20% per year",
    tv: "30% per year",
    camera: "25% per year",
  };

  const suggestions: Record<string, { name: string; price: number }> = {
    phone: brand.includes("apple") ? { name: "iPhone 16", price: Math.round(price * 1.1) } : { name: "Samsung Galaxy S25", price: Math.round(price * 1.05) },
    laptop: { name: "Newer Model Laptop", price: Math.round(price * 1.3) },
    tablet: { name: "iPad Pro M2", price: Math.round(price * 1.2) },
    watch: { name: "Apple Watch Ultra 2", price: Math.round(price * 1.4) },
    headphones: { name: "AirPods Pro 2", price: Math.round(price * 1.1) },
    console: { name: "PS5 Slim", price: Math.round(price * 1.15) },
    tv: { name: "Samsung QLED 55\"", price: Math.round(price * 1.1) },
    camera: { name: "Sony A7 IV", price: Math.round(price * 1.2) },
  };
  const suggestion = suggestions[category] || { name: "Newer Model", price: Math.round(price * 1.2) };

  return {
    device,
    category,
    condition: condition as any,
    estimatedTradeIn: baseTradeIn,
    estimatedResale: baseResale,
    depreciationRate: depreciationRates[category] || "25% per year",
    suggestedNew: suggestion.name,
    suggestedNewPrice: suggestion.price,
    savingsAfterTradeIn: baseTradeIn,
  };
}

export function TradeInScreen() {
  const { t, lang, dir, navigate, isPremium } = useApp();
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [deviceName, setDeviceName] = useState("");
  const [condition, setCondition] = useState<string>("good");
  const [originalPrice, setOriginalPrice] = useState<number | null>(null);
  const [result, setResult] = useState<TradeInResult | null>(null);

  const handleCalculate = () => {
    if (!deviceName.trim() || !selectedCategory || originalPrice === null) return;
    const calc = calculateTradeIn(deviceName.trim(), selectedCategory, condition, originalPrice);
    setResult(calc);
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400"
        >
          <ChevronLeft className={`h-4 w-4 ${dir === "rtl" ? "rotate-180" : ""}`} />
          {t("back")}
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-400 to-purple-600 shadow-lg shadow-purple-500/20">
            <RefreshCw className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="font-serif text-lg font-bold text-purple-400">
              {lang === "ar" ? "حاسبة الاستبدال" : "Trade-in Calculator"}
            </h1>
            <p className="text-xs text-zinc-500">
              {lang === "ar" ? "اعرف قيمة جهازك القديم قبل ما تشتري جديد" : "Know your device value before buying new"}
            </p>
          </div>
        </div>
      </div>

      {/* Device Category Selection */}
      <div className="mb-4 rounded-xl border border-purple-500/20 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold text-purple-400">
          {lang === "ar" ? "اختر نوع الجهاز" : "Select device type"}
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {deviceCategories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`flex flex-col items-center gap-1 rounded-xl p-3 text-xs transition-all ${
                selectedCategory === cat.id
                  ? "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/40"
                  : "bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-purple-300"
              }`}
            >
              <cat.Icon className="h-5 w-5" />
              <span className="text-[10px]">{lang === "ar" ? cat.label : cat.labelEn}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Device Name */}
      <div className="mb-4 rounded-xl border border-purple-500/15 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold text-purple-400">
          {lang === "ar" ? "اسم الجهاز" : "Device Name"}
        </h3>
        <Input
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder={lang === "ar" ? "مثال: iPhone 13 Pro" : "e.g. iPhone 13 Pro"}
          className="border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-purple-500/50"
        />
      </div>

      {/* Condition */}
      <div className="mb-4 rounded-xl border border-purple-500/15 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold text-purple-400">
          {lang === "ar" ? "حالة الجهاز" : "Device Condition"}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {(Object.entries(lang === "ar" ? conditionLabelsAr : conditionLabelsEn) as [string, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setCondition(key)}
              className={`rounded-xl px-3 py-2.5 text-xs transition-all ${
                condition === key
                  ? "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/40"
                  : "bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Original Price */}
      <div className="mb-4 rounded-xl border border-purple-500/15 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold text-purple-400">
          {lang === "ar" ? "سعر الجهاز الأصلي (السعر اللي اشتريته بيه)" : "Original Price (what you paid)"}
        </h3>
        <div className="flex gap-2">
          <Input
            type="number"
            value={originalPrice || ""}
            onChange={(e) => setOriginalPrice(e.target.value ? Number(e.target.value) : null)}
            placeholder={lang === "ar" ? "مثال: 25000" : "e.g. 25000"}
            className="flex-1 border-zinc-700 bg-zinc-800/50 text-zinc-100 placeholder:text-zinc-600 focus:border-purple-500/50"
          />
          <span className="flex items-center text-xs text-zinc-500">EGP</span>
        </div>
      </div>

      {/* Calculate Button */}
      <Button
        onClick={handleCalculate}
        disabled={!deviceName.trim() || !selectedCategory || originalPrice === null}
        className="w-full bg-gradient-to-r from-purple-500 to-purple-600 text-white hover:from-purple-400 hover:to-purple-500 disabled:opacity-40 mb-6"
      >
        <Calculator className="h-4 w-4" /> {lang === "ar" ? "احسب قيمة جهازك" : "Calculate Trade-in Value"}
      </Button>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-5">
            <h3 className="mb-4 font-serif text-base font-bold text-purple-400">
              {lang === "ar" ? "نتيجة التقييم" : "Trade-in Result"}
            </h3>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-lg bg-zinc-800/60 p-3 text-center">
                <p className="text-[10px] text-zinc-500 mb-1">{lang === "ar" ? "قيمة الاستبدال" : "Trade-in Value"}</p>
                <p className="text-lg font-bold text-purple-300">{result.estimatedTradeIn.toLocaleString()} EGP</p>
              </div>
              <div className="rounded-lg bg-zinc-800/60 p-3 text-center">
                <p className="text-[10px] text-zinc-500 mb-1">{lang === "ar" ? "قيمة البيع المباشر" : "Direct Resale"}</p>
                <p className="text-lg font-bold text-emerald-300">{result.estimatedResale.toLocaleString()} EGP</p>
              </div>
            </div>

            {/* Trade-in vs Resale comparison */}
            <div className="rounded-lg bg-zinc-800/30 p-3 mb-4">
              <p className="text-xs text-zinc-400 mb-2">{lang === "ar" ? "الفرق بين الاستبدال والبيع المباشر:" : "Trade-in vs Direct Resale:"}</p>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="h-4 rounded-full bg-purple-500/30 overflow-hidden">
                    <div className="h-full rounded-full bg-purple-500" style={{ width: "100%" }} />
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{lang === "ar" ? "استبدال (أسرع)" : "Trade-in (Faster)"}</p>
                </div>
                <div className="flex-1">
                  <div className="h-4 rounded-full bg-emerald-500/30 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round(result.estimatedTradeIn / result.estimatedResale * 100)}%` }} />
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{lang === "ar" ? "بيع مباشر (أعلى سعر)" : "Direct Sale (Higher)"}</p>
                </div>
              </div>
              <p className="text-[10px] text-zinc-500 mt-2">
                {lang === "ar"
                  ? `💡 الاستبدال أسرع وأسهل لكن أقل بـ ${((result.estimatedResale - result.estimatedTradeIn) / result.estimatedResale * 100).toFixed(0)}%. البيع المباشر يعطيك فلوس أكتر لكن يأخد وقت.`
                  : `💡 Trade-in is faster and easier but ${((result.estimatedResale - result.estimatedTradeIn) / result.estimatedResale * 100).toFixed(0)}% less. Direct sale gives you more money but takes time.`}
              </p>
            </div>

            {/* Depreciation */}
            <div className="flex items-center gap-2 rounded-lg bg-zinc-800/30 p-3 mb-4">
              <TrendingDown className="h-4 w-4 text-red-400" />
              <p className="text-xs text-zinc-300">
                {lang === "ar"
                  ? `معدل انخفاض القيمة: ${result.depreciationRate}`
                  : `Depreciation rate: ${result.depreciationRate}`}
              </p>
            </div>

            {/* Upgrade suggestion */}
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
              <p className="text-xs font-bold text-amber-400 mb-1">
                {lang === "ar" ? "💡 اقتراح ترقية:" : "💡 Upgrade Suggestion:"}
              </p>
              <p className="text-xs text-zinc-300">
                {lang === "ar"
                  ? `مع ${result.estimatedTradeIn.toLocaleString()} جنيه من الاستبدال، يمكنك ترقية جهازك إلى ${result.suggestedNew} بسعر ${result.suggestedNewPrice.toLocaleString()} جنيه — يعني تدفع فرق ${Math.abs(result.suggestedNewPrice - result.estimatedTradeIn).toLocaleString()} جنيه فقط!`
                  : `With ${result.estimatedTradeIn.toLocaleString()} EGP from trade-in, you can upgrade to ${result.suggestedNew} at ${result.suggestedNewPrice.toLocaleString()} EGP — meaning you only pay the difference of ${Math.abs(result.suggestedNewPrice - result.estimatedTradeIn).toLocaleString()} EGP!`}
              </p>
            </div>
          </div>

          {/* Tips */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <h4 className="text-xs font-bold text-zinc-400 mb-2">
              {lang === "ar" ? "نصائح لزيادة قيمة جهازك:" : "Tips to increase your device value:"}
            </h4>
            <ul className="space-y-1.5">
              {(lang === "ar"
                ? [
                    "نظف الجهاز قبل التقييم — جهاز نظيف يبان أحسن",
                    "جهز العلبة والملحقات (الشاحن، الكابل، العلبة) — بتزيد القيمة 10-15%",
                    "صوّر الجهاز من كل الاتجاهات — صور واضحة بتدي ثقة للمشتري",
                    "لو الجهاز فيه ضمان لسه شغال — ده بيزود القيمة 5-10%",
                    "قارن أسعار المنصات المختلفة (OLX، مستعمل.eg، ReSell) قبل ما تختار",
                  ]
                : [
                    "Clean the device before valuation — a clean device looks better",
                    "Prepare the box and accessories (charger, cable, box) — adds 10-15% value",
                    "Take photos from all angles — clear photos build buyer trust",
                    "If warranty is still active — adds 5-10% value",
                    "Compare platform prices (OLX, Resell, etc.) before choosing",
                  ]
              ).map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-zinc-400">
                  <Sparkles className="h-3 w-3 shrink-0 text-amber-400 mt-0.5" />
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
