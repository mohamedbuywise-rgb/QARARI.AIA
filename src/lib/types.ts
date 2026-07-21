export type Language = "ar" | "en";
export type Verdict = "good" | "fair" | "bad";
export type Screen = "input" | "report" | "history" | "profile" | "login" | "upgrade" | "compare" | "guide" | "advisor";

export interface Currency {
  code: string;
  enName: string;
  arName: string;
  enShort: string;
  arShort: string;
}

export const currencies: Currency[] = [
  { code: "EGP", enName: "Egyptian Pound", arName: "جنيه مصري", enShort: "EGP", arShort: "جنيه" },
  { code: "USD", enName: "US Dollar", arName: "دولار أمريكي", enShort: "USD", arShort: "دولار" },
  { code: "SAR", enName: "Saudi Riyal", arName: "ريال سعودي", enShort: "SAR", arShort: "ريال" },
  { code: "AED", enName: "UAE Dirham", arName: "درهم إماراتي", enShort: "AED", arShort: "درهم" },
  { code: "EUR", enName: "Euro", arName: "يورو", enShort: "EUR", arShort: "يورو" },
  { code: "KWD", enName: "Kuwaiti Dinar", arName: "دينار كويتي", enShort: "KWD", arShort: "دينار" },
];

export const FREE_MONTHLY_LIMIT = 5;
export const MONTHLY_PRICE = 150;
export const INSTAPAY_NUMBER = "01025204455";
export const SUPPORT_WHATSAPP = "201143494418";

export interface BilingualText {
  ar: string;
  en: string;
}

export interface BilingualArray {
  ar: string[];
  en: string[];
}

export interface Alternative {
  name: string;
  estimatedPrice: number;
  reason: BilingualText;
  whySuitable: BilingualText;
}

export interface AnalysisResult {
  id: string;
  product: string;
  offeredPrice: number;
  currency: string;
  condition?: string;
  verdict: Verdict;
  // Nullable: the backend now allows the AI to return null for these when it
  // genuinely has no reliable pricing data, instead of inventing a number.
  marketFairPriceMin: number | null;
  marketFairPriceMax: number | null;
  marketFairPriceMid: number | null;
  // A single Gemini/Google-AI-Overview-style analytical paragraph describing
  // the current market price range in natural language (new vs used, min/max).
  marketPriceSummary: BilingualText;
  moneySaved: number | null;
  reasoningPoints: BilingualArray;
  preRecommendation: BilingualText;
  futureCompatibility: BilingualText;
  regretLevel: "low" | "medium" | "high";
  regretJustification: BilingualText;
  pros: BilingualArray;
  cons: BilingualArray;
  hiddenRisks: BilingualArray;
  finalTip: BilingualText;
  betterAlternatives: Alternative[];
  negotiationScript: BilingualText;
  communityInsights?: {
    analyzedCount: number;
    recentPrices: number[];
  } | null;
  // Resale Value Prediction
  resaleValueRightNow?: number;
  resaleValue1Year?: number;
  resaleValue2Years?: number;
  resaleDepreciationRate?: string;
  resaleInsight?: BilingualText;
  // Trade-in Calculator
  tradeInValue?: number;
  tradeInPlatformLinks?: { name: string; url: string; estimatedPrice: number }[];
  createdAt: number;
}

export interface CompareRow {
  category: BilingualText;
  valueA: BilingualText;
  valueB: BilingualText;
  winner: "A" | "B" | "tie";
}

export interface CompareResult {
  productA: string;
  productB: string;
  rows: CompareRow[];
  finalRecommendation: BilingualText;
  priceA: number;
  priceB: number;
  currency: string;
  resaleValueA?: number;
  resaleValueB?: number;
  resaleValueTimeframe?: string;
  warrantyScoreA?: number;
  warrantyScoreB?: number;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  age: string;
  country: string;
  phone: string;
  interests: string[];
  tier: "free" | "premium";
  subscriptionEndDate: number | null;
  referralCode: string;
  inviteCount: number;
}