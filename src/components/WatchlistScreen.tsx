import { useEffect, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { supabase } from "@/lib/supabase";
import { currencies } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Bell, BellOff, ChevronLeft, TrendingDown, Clock, Sparkles } from "lucide-react";

interface WatchlistRow {
  id: string;
  product: string;
  saved_price: number;
  currency: string;
  active: boolean;
  created_at: string;
  last_checked_price: number | null;
  last_checked_at: string | null;
  notified_at: string | null;
}

export function WatchlistScreen() {
  const { t, lang, dir, navigate, user, showToast } = useApp();
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const currencyShort = (code: string) => {
    const c = currencies.find((c) => c.code === code);
    return lang === "ar" ? c?.arShort : c?.enShort;
  };

  useEffect(() => {
    if (!user) {
      navigate("login");
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from("watchlist")
        .select("*")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      if (!cancelled) {
        if (!error && data) setRows(data as WatchlistRow[]);
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user, navigate]);

  const stopTracking = async (row: WatchlistRow) => {
    setRemovingId(row.id);
    // Soft-delete: flip active=false so the daily cron stops checking it.
    // (There's no delete RLS policy on watchlist, only insert/select/update.)
    const { error } = await supabase.from("watchlist").update({ active: false }).eq("id", row.id);
    if (!error) {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      showToast(t("stoppedTracking"));
    }
    setRemovingId(null);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate("input")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/50 text-zinc-400 transition-colors hover:text-amber-400"
        >
          {dir === "rtl" ? <ChevronLeft className="h-5 w-5 rotate-180" /> : <ChevronLeft className="h-5 w-5" />}
        </button>
        <h1 className="font-serif text-2xl font-bold text-amber-400">{t("watchlistTitle")}</h1>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-700 py-16 text-center">
          <Bell className="mb-3 h-12 w-12 text-zinc-700" />
          <p className="text-sm font-medium text-zinc-400">{t("noWatchlist")}</p>
          <p className="mt-1 text-xs text-zinc-600">{t("noWatchlistDesc")}</p>
          <Button onClick={() => navigate("input")} className="mt-4 bg-amber-500 text-[#0B0B0F] hover:bg-amber-400">
            <Sparkles className="h-4 w-4" /> {t("newDecision")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const cShort = currencyShort(row.currency);
            const dropped =
              typeof row.last_checked_price === "number" && row.last_checked_price <= row.saved_price * 0.95;
            return (
              <div
                key={row.id}
                className={`rounded-xl border p-4 transition-colors ${
                  dropped ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900/60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-bold text-zinc-100">{row.product}</h3>
                    <p className="mt-1 text-xs text-zinc-500">
                      {t("savedPriceLabel")}: {row.saved_price.toLocaleString()} {cShort}
                    </p>
                    {typeof row.last_checked_price === "number" ? (
                      <p className={`mt-0.5 flex items-center gap-1 text-xs font-medium ${dropped ? "text-emerald-400" : "text-zinc-500"}`}>
                        {dropped && <TrendingDown className="h-3.5 w-3.5" />}
                        {t("currentPriceLabel")}: {row.last_checked_price.toLocaleString()} {cShort}
                      </p>
                    ) : (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-600">
                        <Clock className="h-3.5 w-3.5" /> {t("notCheckedYet")}
                      </p>
                    )}
                    {dropped && (
                      <span className="mt-2 inline-block rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                        {t("priceDroppedBadge")}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => stopTracking(row)}
                    disabled={removingId === row.id}
                    title={t("stopTracking")}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400 disabled:opacity-50"
                  >
                    {removingId === row.id ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
                    ) : (
                      <BellOff className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
