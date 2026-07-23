import { useApp } from "@/lib/AppContext";
import { Button } from "@/components/ui/button";
import { Crown, Check, ChevronLeft, Zap, Star, ShieldCheck, Rocket } from "lucide-react";

export function UpgradeScreen() {
  const { t, lang, navigate } = useApp();

  const handleSubscribeClick = () => {
    window.open("https://www.instagram.com/qarari.ai", "_blank");
  };

  const PlanCard = ({ 
    title, 
    price, 
    features, 
    highlight = false, 
    badge = "", 
    isFree = false 
  }: { 
    title: string; 
    price: string; 
    features: string; 
    highlight?: boolean; 
    badge?: string;
    isFree?: boolean;
  }) => (
    <div className={`relative rounded-2xl border ${highlight ? 'border-amber-500 bg-amber-500/5 shadow-lg shadow-amber-500/10' : 'border-zinc-800 bg-zinc-900/40'} p-6 transition-all hover:border-amber-500/50`}>
      {badge && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-[#0B0B0F]">
          {badge}
        </div>
      )}
      <div className="mb-4">
        <h3 className={`text-lg font-bold ${highlight ? 'text-amber-400' : 'text-zinc-200'}`}>{title}</h3>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold text-zinc-100">{price}</span>
        </div>
      </div>
      <div className="mb-6 space-y-3">
        {features.split('+').map((feature, i) => (
          <div key={i} className="flex items-start gap-2">
            <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="text-xs text-zinc-400">{feature.trim()}</p>
          </div>
        ))}
      </div>
      {!isFree && (
        <Button
          onClick={handleSubscribeClick}
          className={`w-full font-bold ${highlight ? 'bg-amber-500 text-[#0B0B0F] hover:bg-amber-400' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
        >
          <Zap className="mr-2 h-4 w-4" /> {t("subscribeNow")}
        </Button>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 pb-20">
      <button
        onClick={() => navigate("input")}
        className="mb-6 flex items-center gap-1 text-sm text-zinc-400 hover:text-amber-400"
      >
        <ChevronLeft className={`h-4 w-4 ${lang === "ar" ? "rotate-180" : ""}`} />
        {t("back")}
      </button>

      <div className="mb-10 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-xl shadow-amber-500/20">
          <Crown className="h-8 w-8 text-[#0B0B0F]" />
        </div>
        <h1 className="font-serif text-3xl font-bold text-amber-400">{t("premium")}</h1>
        <p className="mt-2 text-sm text-zinc-400">{t("premiumDesc")}</p>
      </div>

      <div className="space-y-12">
        {/* Free Plan */}
        <section>
          <PlanCard 
            title={t("freePlan")}
            price={lang === "ar" ? "مجانًا" : "Free"}
            features={t("freePlanFeatures")}
            isFree={true}
          />
        </section>

        {/* Direct Use Bundles */}
        <section>
          <div className="mb-6 flex items-center gap-3">
            <Star className="h-5 w-5 text-amber-500" />
            <h2 className="text-xl font-bold text-zinc-100">{t("oneTimePlans")}</h2>
            <span className="rounded-full bg-zinc-800 px-3 py-1 text-[10px] font-medium text-zinc-400">
              {t("noExpiration")}
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <PlanCard 
              title={t("oneTimeSmall")}
              price={t("oneTimeSmallPrice")}
              features={t("oneTimeSmallFeatures")}
            />
            <PlanCard 
              title={t("oneTimeMedium")}
              price={t("oneTimeMediumPrice")}
              features={t("oneTimeMediumFeatures")}
              highlight={true}
              badge={lang === "ar" ? "الأكثر طلبًا" : "Popular"}
            />
            <PlanCard 
              title={t("oneTimeLarge")}
              price={t("oneTimeLargePrice")}
              features={t("oneTimeLargeFeatures")}
            />
          </div>
        </section>

        {/* Monthly Subscriptions */}
        <section>
          <div className="mb-6 flex items-center gap-3">
            <Rocket className="h-5 w-5 text-amber-500" />
            <h2 className="text-xl font-bold text-zinc-100">{lang === "ar" ? "اشتراكات شهرية" : "Monthly Subscriptions"}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <PlanCard 
              title={t("smartShopper")}
              price={t("smartShopperPrice")}
              features={t("smartShopperFeatures")}
            />
            <PlanCard 
              title={t("powerBuyer")}
              price={t("powerBuyerPrice")}
              features={t("powerBuyerFeatures")}
              highlight={true}
              badge={lang === "ar" ? "للمحترفين" : "Pro"}
            />
          </div>
        </div>

        {/* Value reinforcement */}
        <div className="mt-12 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
          <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-400">
            {lang === "ar" 
              ? "قرار شراء واحد صحيح يوفر لك آلاف الجنيهات!" 
              : "One right purchase decision saves you thousands!"}
          </p>
        </div>
      </div>
    </div>
  );
}
