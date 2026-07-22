import { useEffect, useRef, useState } from "react";

const SESSION_KEY = "qarari_splash_shown";
const SCENE1_MS = 2000;
const SCENE2_START = 2400;
const SCENE2_STRIKE = 3100;
const SCENE2_COUNT = 3600;
const SCENE2_END = 6200;
const SCENE3_START = 6600;
const TOTAL_MS = 8600;

export function SplashScreen({ onFinish }: { onFinish: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<0 | 1 | 2 | 3>(1);
  const [savings, setSavings] = useState(0);
  const [struck, setStruck] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = window.innerWidth;
    let H = window.innerHeight;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const dust = Array.from({ length: 65 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: 0.3 + Math.random() * 0.7,
      size: 0.8 + Math.random() * 1.5,
      drift: (Math.random() - 0.5) * 0.15,
      twinkle: Math.random() * Math.PI * 2,
    }));

    let rafId: number;
    function draw(t: number) {
      ctx!.clearRect(0, 0, W, H);
      for (const d of dust) {
        d.x += d.drift * d.z;
        d.y += Math.sin(t / 2500 + d.x * 0.01) * 0.06;
        if (d.x < -10) d.x = W + 10;
        if (d.x > W + 10) d.x = -10;
        const tw = 0.5 + 0.5 * Math.sin(t / 400 + d.twinkle);
        const alpha = 0.15 * d.z * tw;
        ctx!.beginPath();
        ctx!.arc(d.x, d.y, d.size, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(212,175,55,${alpha})`;
        ctx!.fill();
      }
      rafId = requestAnimationFrame(draw);
    }
    rafId = requestAnimationFrame(draw);

    const onResize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    at(SCENE1_MS, () => setScene(0));
    at(SCENE2_START, () => setScene(2));
    at(SCENE2_STRIKE, () => setStruck(true));
    at(SCENE2_COUNT, () => {
      const target = 6500;
      const start = performance.now();
      const duration = 1200;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 4);
        setSavings(Math.round(eased * target));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    at(SCENE2_END, () => setScene(0));
    at(SCENE3_START, () => setScene(3));
    at(TOTAL_MS, () => {
      sessionStorage.setItem(SESSION_KEY, "1");
      onFinish();
    });

    return () => timers.forEach(clearTimeout);
  }, [onFinish]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0B0B0F] overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(circle at center, transparent 0%, rgba(0,0,0,0.8) 100%)",
        }}
      />

      <div className="relative z-10 w-full max-w-md px-7 text-center">
        {/* Scene 1 */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center transition-all duration-1000"
          style={{ 
            opacity: scene === 1 ? 1 : 0,
            transform: scene === 1 ? "scale(1)" : "scale(0.95)"
          }}
        >
          <p className="text-2xl font-light leading-relaxed text-zinc-200">
            كل يوم بتتخذ <span className="font-semibold text-amber-400">قرارات شراء</span>
            <br />
            من غير ما تعرف السعر العادل فعلاً
          </p>
        </div>

        {/* Scene 2 */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center transition-all duration-1000"
          style={{ 
            opacity: scene === 2 ? 1 : 0,
            transform: scene === 2 ? "scale(1)" : "scale(1.05)"
          }}
        >
          <div className="mb-4 text-[0.78rem] uppercase tracking-[0.25em] text-zinc-500 font-bold">
            تحليل لحظي بالذكاء الاصطناعي
          </div>
          <div className="mb-2 flex items-baseline justify-center gap-3">
            <span
              className="relative text-2xl text-zinc-500 transition-all duration-500"
              style={{
                textDecoration: struck ? "line-through" : "none",
                textDecorationColor: "#ef4444",
                textDecorationThickness: "2px",
              }}
            >
              25,000 ج.م
            </span>
            <span className="text-xl text-amber-400">←</span>
            <span className="text-3xl font-bold text-amber-200 drop-shadow-[0_0_15px_rgba(251,191,36,0.3)]">18,500 ج.م</span>
          </div>
          <div
            className="cta-glow mt-5 inline-flex flex-col items-center gap-1 rounded-2xl border px-8 py-3.5 transition-all duration-700"
            style={{
              borderColor: "rgba(251,191,36,0.4)",
              background: "rgba(251,191,36,0.1)",
              opacity: savings > 0 ? 1 : 0,
              transform: savings > 0 ? "translateY(0)" : "translateY(20px)",
            }}
          >
            <span className="text-2xl font-bold text-amber-400">
              {savings.toLocaleString("en-US")} ج.م
            </span>
            <span className="text-[0.7rem] uppercase tracking-widest text-zinc-300 font-bold">
              كنت هتوفرهم
            </span>
          </div>
          <p className="mt-4 text-[0.68rem] text-zinc-600 italic">*مثال توضيحي لنتيجة تحليل حقيقي</p>
        </div>

        {/* Scene 3 */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center transition-all duration-1000"
          style={{ 
            opacity: scene === 3 ? 1 : 0,
            transform: scene === 3 ? "scale(1)" : "scale(1.1)"
          }}
        >
          <div className="relative mb-6">
             <div className="absolute inset-0 blur-2xl bg-amber-400/20 rounded-full animate-pulse" />
             <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-2xl shadow-amber-500/40">
                <Sparkles className="h-10 w-10 text-black" />
             </div>
          </div>
          <div className="gold-shimmer text-4xl font-bold tracking-wide">
            Qarari.AI
          </div>
          <p className="mt-2.5 text-sm text-zinc-400 font-medium">
            حلّل أي قرار شراء في ثواني، قبل ما تدفع زيادة
          </p>
          <div className="mt-8 flex items-center gap-2">
             <div className="h-1 w-12 rounded-full bg-zinc-800 overflow-hidden">
                <div className="h-full bg-amber-400 animate-shimmer-loading" style={{ width: '100%' }} />
             </div>
             <p className="text-[0.72rem] uppercase tracking-[0.2em] text-zinc-600 font-bold">
               جاري التحميل…
             </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function shouldShowSplash(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) !== "1";
  } catch {
    return true;
  }
}
