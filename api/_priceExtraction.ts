// Backend-side price extraction & currency conversion.
//
// WHY THIS FILE EXISTS
// ---------------------
// Previously, currency handling was left entirely to the AI model: it read
// the raw Tavily search text and was expected to notice the currency,
// convert it to whatever the user asked for, and produce marketFairPriceMin
// /Mid/Max. In practice, whenever the search results only contained a
// currency different from the one the user selected, the model would just
// give up and return "Fair price unavailable" instead of converting.
//
// This module moves price extraction + currency conversion into the
// backend, where it's deterministic and reliable:
//
//   Tavily results (raw text)
//     -> extract every "number + nearby currency marker" pair
//     -> group by detected currency
//     -> if the user's requested currency is present, use those numbers as-is
//     -> otherwise convert the most common OTHER currency found -> requested
//        currency, using a live exchange rate (cached for a few hours)
//     -> return { min, max, mid } already in the requested currency
//
// The caller (currently only _groq_tavily.ts, for the single-product
// analyze flow) then injects these already-normalized numbers into the
// search context handed to Groq, so Groq no longer needs to do the
// conversion itself — it just has to use the numbers it's given.
//
// Nothing here changes response shape, prompts, caching of analysis
// results, or any other part of the app. The only new "cache" is a small
// in-memory exchange-rate cache described below.

export const SUPPORTED_CURRENCIES = [
  "USD",
  "EGP",
  "SAR",
  "AED",
  "KWD",
  "EUR",
  "GBP",
  "QAR",
  "BHD",
  "OMR",
  "JOD",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

// ---- Currency detection ----
//
// Ordered list of (currency code -> regex that matches how it tends to show
// up in English/Arabic web text). Order matters: more specific patterns
// (e.g. EGP's "E£") must be checked before patterns they could collide with
// (GBP's plain "£").
const CURRENCY_PATTERNS: { code: SupportedCurrency; regex: RegExp }[] = [
  { code: "EGP", regex: /(E£|EGP|L\.?E\.?\b|ج\.م|جنيه\s*مصري|جنيه)/i },
  { code: "SAR", regex: /(SAR|S\.?R\.?\b|ر\.س|ريال\s*سعودي)/i },
  { code: "AED", regex: /(AED|DHS\b|Dhs\b|د\.إ|درهم\s*إماراتي|درهم)/i },
  { code: "KWD", regex: /(KWD|K\.?D\.?\b|د\.ك|دينار\s*كويتي)/i },
  { code: "QAR", regex: /(QAR|ر\.ق|ريال\s*قطري)/i },
  { code: "BHD", regex: /(BHD|د\.ب|دينار\s*بحريني)/i },
  { code: "OMR", regex: /(OMR|ر\.ع|ريال\s*عماني)/i },
  { code: "JOD", regex: /(JOD|د\.أ|دينار\s*أردني)/i },
  { code: "EUR", regex: /(€|EUR)/i },
  { code: "GBP", regex: /(£|GBP)/i },
  { code: "USD", regex: /(US\$|USD|\$)/i },
];

function detectCurrencyInWindow(window: string): SupportedCurrency | null {
  for (const { code, regex } of CURRENCY_PATTERNS) {
    if (regex.test(window)) return code;
  }
  return null;
}

// Matches numbers like "58,999", "1,050.50", "999" — but not bare digits
// glued to letters (so "128GB" alone still won't match without a currency
// marker nearby, since the caller requires one).
const NUMBER_PATTERN = /\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

const MIN_PLAUSIBLE_PRICE = 1;
const MAX_PLAUSIBLE_PRICE = 20_000_000;
const WINDOW_CHARS = 15;

export interface DetectedPrice {
  value: number;
  currency: SupportedCurrency;
}

// Scans free text for "number with a currency symbol/code within ~15 chars"
// pairs. A number with no nearby currency marker is ignored — this is what
// keeps specs like "128GB" or "5000mAh" from being misread as prices.
export function collectPricesFromText(text: string): DetectedPrice[] {
  const found: DetectedPrice[] = [];
  const re = new RegExp(NUMBER_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const idx = m.index;
    const before = text.slice(Math.max(0, idx - WINDOW_CHARS), idx);
    const after = text.slice(idx + raw.length, idx + raw.length + WINDOW_CHARS);
    const currency = detectCurrencyInWindow(before) ?? detectCurrencyInWindow(after);
    if (!currency) continue;

    const value = parseFloat(raw.replace(/[,\s]/g, ""));
    if (!isFinite(value) || value < MIN_PLAUSIBLE_PRICE || value > MAX_PLAUSIBLE_PRICE) continue;

    found.push({ value, currency });
  }
  return found;
}

// ---- Exchange rates ----
//
// Uses open.er-api.com (free, no API key, updates daily, covers all
// currencies in SUPPORTED_CURRENCIES including the Gulf currencies) as the
// primary source, with the fawazahmed0/currency-api mirror on jsdelivr as a
// fallback if the primary is unreachable. Results are cached in-memory per
// warm serverless instance for a few hours so we don't hit the rate API on
// every single scan.
const RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface RateCacheEntry {
  rates: Record<string, number>;
  fetchedAt: number;
}

const rateCache = new Map<string, RateCacheEntry>();

async function fetchRatesFromOpenErApi(base: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
    if (!res.ok) return null;
    const json: any = await res.json();
    if (json?.result !== "success" || typeof json?.rates !== "object") return null;
    return json.rates;
  } catch (e) {
    console.error("[PriceExtraction] open.er-api.com fetch failed:", e);
    return null;
  }
}

async function fetchRatesFromFawazMirror(base: string): Promise<Record<string, number> | null> {
  try {
    const lower = base.toLowerCase();
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${lower}.json`
    );
    if (!res.ok) return null;
    const json: any = await res.json();
    const rates = json?.[lower];
    if (!rates || typeof rates !== "object") return null;
    const upper: Record<string, number> = {};
    for (const [k, v] of Object.entries(rates)) {
      if (typeof v === "number") upper[k.toUpperCase()] = v;
    }
    return upper;
  } catch (e) {
    console.error("[PriceExtraction] fawazahmed0 mirror fetch failed:", e);
    return null;
  }
}

async function getRatesForBase(base: string): Promise<Record<string, number> | null> {
  const cached = rateCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL_MS) {
    return cached.rates;
  }

  let rates = await fetchRatesFromOpenErApi(base);
  if (!rates) rates = await fetchRatesFromFawazMirror(base);
  if (!rates) return null;

  rateCache.set(base, { rates, fetchedAt: Date.now() });
  return rates;
}

// Returns how many `to` units equal 1 `from` unit, or null if the rate
// genuinely could not be fetched from either provider.
export async function getExchangeRate(from: SupportedCurrency, to: SupportedCurrency): Promise<number | null> {
  if (from === to) return 1;

  const forward = await getRatesForBase(from);
  if (forward && typeof forward[to] === "number") return forward[to];

  // Fall back to fetching the inverse and dividing, in case a provider only
  // has one of the two currencies as a valid base.
  const inverse = await getRatesForBase(to);
  if (inverse && typeof inverse[from] === "number" && inverse[from] !== 0) {
    return 1 / inverse[from];
  }

  return null;
}

// ---- Putting it together ----

export interface MarketPriceRange {
  min: number;
  mid: number;
  max: number;
  targetCurrency: SupportedCurrency;
  sourceCurrency: SupportedCurrency; // currency the raw prices were found in
  rate: number; // 1 sourceCurrency = `rate` targetCurrency
  sampleSize: number;
}

function buildRange(
  values: number[],
  targetCurrency: SupportedCurrency,
  sourceCurrency: SupportedCurrency,
  rate: number
): MarketPriceRange {
  const sorted = [...values].sort((a, b) => a - b);
  const min = Math.round(sorted[0]);
  const max = Math.round(sorted[sorted.length - 1]);
  const mid = Math.round((min + max) / 2);
  return { min, mid, max, targetCurrency, sourceCurrency, rate, sampleSize: values.length };
}

// Main entry point. Give it the raw Tavily results (title + content) plus
// the currency the user asked for, and it returns a normalized min/mid/max
// already in that currency — converting from whichever currency the search
// results actually used, if needed. Returns null only when no usable price
// could be found or converted at all.
export async function computeMarketPriceRange(
  tavilyTexts: string[],
  targetCurrencyRaw: string
): Promise<MarketPriceRange | null> {
  if (!isSupportedCurrency(targetCurrencyRaw)) return null;
  const targetCurrency = targetCurrencyRaw.toUpperCase() as SupportedCurrency;

  const combinedText = tavilyTexts.join(" \n ");
  const allPrices = collectPricesFromText(combinedText);
  if (allPrices.length === 0) return null;

  // CASE 1: the requested currency already shows up directly in the results.
  const exact = allPrices.filter((p) => p.currency === targetCurrency);
  if (exact.length > 0) {
    return buildRange(
      exact.map((p) => p.value),
      targetCurrency,
      targetCurrency,
      1
    );
  }

  // CASE 2: no direct match — convert from whichever OTHER currency shows up
  // most often in the results (the most likely "real" source currency).
  const byCurrency = new Map<SupportedCurrency, number[]>();
  for (const p of allPrices) {
    const list = byCurrency.get(p.currency) ?? [];
    list.push(p.value);
    byCurrency.set(p.currency, list);
  }
  const [sourceCurrency, sourceValues] = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  const rate = await getExchangeRate(sourceCurrency, targetCurrency);
  if (rate === null) return null; // conversion genuinely impossible right now

  const converted = sourceValues.map((v) => v * rate);
  return buildRange(converted, targetCurrency, sourceCurrency, rate);
}

// Formats the computed range into a short, unambiguous instruction block to
// append to the search context handed to Groq. Returns "" when there's
// nothing to inject (caller just leaves the model's existing fallback
// behavior — reading the raw search text itself — untouched).
export function formatMarketPriceContext(range: MarketPriceRange | null): string {
  if (!range) return "";

  const sourceNote =
    range.sourceCurrency === range.targetCurrency
      ? `These figures were found directly in ${range.targetCurrency} in the search results above — no currency conversion was needed.`
      : `These figures were found in ${range.sourceCurrency} in the search results above and have already been converted to ${range.targetCurrency} by the backend using a live exchange rate (1 ${range.sourceCurrency} = ${range.rate.toFixed(4)} ${range.targetCurrency}).`;

  return `\n\nBACKEND-EXTRACTED MARKET PRICE DATA (authoritative — already parsed and, if needed, currency-converted from the live search results by the backend, not by you):
- marketFairPriceMin: ${range.min} ${range.targetCurrency}
- marketFairPriceMid: ${range.mid} ${range.targetCurrency}
- marketFairPriceMax: ${range.max} ${range.targetCurrency}
${sourceNote}
Use these numbers (or numbers very close to them, refined only slightly using your own reading of the search results) for marketFairPriceMin/Mid/Max in your JSON response. Do NOT redo the currency conversion yourself, and do NOT return null/"unavailable" for these fields — real pricing data is available.`;
}
