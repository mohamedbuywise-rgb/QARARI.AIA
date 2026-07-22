import { useApp } from "@/lib/AppContext";
import { CheckCircle2 } from "lucide-react";

export function Toast() {
  const { toast, dir } = useApp();
  if (!toast) return null;

  return (
    <div
      className={`slide-up fixed bottom-6 ${dir === "rtl" ? "left-6" : "right-6"} z-50 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-zinc-900/95 px-4 py-3 shadow-2xl backdrop-blur-md`}
      style={{
        boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 12px rgba(212,175,55,0.15)",
      }}
    >
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-400/20">
        <CheckCircle2 className="h-4 w-4 text-amber-400" />
      </div>
      <span className="text-sm font-medium text-zinc-100">{toast}</span>
    </div>
  );
}
