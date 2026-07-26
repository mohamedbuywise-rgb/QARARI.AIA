import { useEffect, useState } from "react";
import { Search, ShoppingBag, Scale, Sparkles, CheckCircle2 } from "lucide-react";

interface StreamStep {
  icon: typeof Search;
  ar: string;
  en: string;
}

const STEPS: StreamStep[] = [
  { icon: Search, ar: "بندور على المنتج في السوق...", en: "Searching the market for this product..." },
  { icon: ShoppingBag, ar: "بنجمع أسعار من أكبر المتاجر...", en: "Gathering prices from major retailers..." },
  { icon: Scale, ar: "بنقارن السعر بالسعر العادل...", en: "Comparing the offer to a fair price..." },
  { icon: Sparkles, ar: "بنجهزلك التقرير النهائي...", en: "Putting together your final report..." },
];

// Purely cosmetic staged progress — this never estimates or displays any
// price number, it only tells the person the request is alive while the
// real /api/analyze call is in flight. The bar eases toward ~92% and waits
// there; the caller is responsible for unmounting this once the real
// response comes back, at which point the UI just moves straight to the
// report screen.
export function AnalyzingStream({ lang }: { lang: "ar" | "en" }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [progress, setProgress] = useState(4);

  useEffect(() => {
    const stepTimer = setInterval(() => {
      setStepIndex((i) => (i < STEPS.length - 1 ? i + 1 : i));
    }, 2200);
    const progressTimer = setInterval(() => {
      setProgress((p) => (p < 92 ? p + Math.max(1, (92 - p) * 0.08) : p));
    }, 250);
    return () => {
      clearInterval(stepTimer);
      clearInterval(progressTimer);
    };
  }, []);

  return (
    <div
      className="mt-5 rounded-2xl border border-amber-500/20 p-5 shadow-xl"
      style={{ backgroundColor: "#121214" }}
    >
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-amber-600 shadow-lg shadow-amber-500/30">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#121214] border-t-transparent" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-amber-400">
            {lang === "ar" ? "جاري التحليل..." : "Analyzing..."}
          </p>
          <p className="truncate text-xs text-zinc-500">
            {lang === "ar" ? "ده بياخد كام ثانية عادةً" : "This usually takes a few seconds"}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{ width: `${Math.min(progress, 100)}%`, backgroundColor: "#f59e0b" }}
        />
      </div>

      {/* Status log */}
      <div className="space-y-2">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          const done = i < stepIndex;
          const active = i === stepIndex;
          const pending = i > stepIndex;
          return (
            <div
              key={i}
              className={`flex items-center gap-2.5 text-xs transition-opacity duration-300 ${
                pending ? "opacity-35" : "opacity-100"
              }`}
            >
              {done ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : (
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${active ? "text-amber-400 animate-pulse" : "text-zinc-600"}`}
                />
              )}
              <span className={done ? "text-zinc-500 line-through" : active ? "font-medium text-zinc-200" : "text-zinc-600"}>
                {lang === "ar" ? step.ar : step.en}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
