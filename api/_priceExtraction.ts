// Backend-side price extraction, filtering, outlier removal & currency
// conversion.
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
// This module moves the ENTIRE price pipeline into the backend, where it's
// deterministic, testable, and reliable:
//
//   Tavily results (title + content, per result, with source URL)
//     -> Step 1: extract every "number + nearby currency marker" pair
//     -> Step 2: reject values that sit next to noise keywords (trade-in,
//        financing, /month, accessories, shipping, coupons, etc.)
//     -> Step 3: weight surviving values by how trustworthy their source
//        domain is (official stores / major retailers > unknown blogs)
//     -> Step 4: remove statistical outliers per currency group using a
//        median/IQR method (never Math.min()/Math.max())
//     -> Step 5: compute marketFairPriceMin/Mid/Max from what's left
//     -> Step 6: convert currencies ONLY AFTER all of the above, never before
//     -> Step 7: if nothing survives, return null (never a fake range)
//
// The caller (currently only _groq_tavily.ts, for the single-product
// analyze flow) then injects these already-normalized numbers into the
// search context handed to Groq, so Groq no longer estimates prices at all —
// it only explains/analyzes numbers the backend already computed.
//
// Nothing here changes response shape, prompts, caching of analysis
// results, UI, auth, scoring, verdict/recommendation logic, translation, or
// any other part of the app.

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

// ============================================================================
// STEP 1 — Extract every possible money value from raw text
// ============================================================================

// Ordered list of (currency code -> regex that matches how it tends to show
// up in English/Arabic web text). Order matters: more specific patterns
// (e.g. EGP's "E£") must be checked before patterns they could collide with
// (GBP's plain "£").
const CURRENCY_PATTERNS: { code: SupportedCurrency; regex: RegExp }[] = [
  // BUG FOUND: these four short-form patterns (L.E., S.R., DHS, K.D.) were
  // missing a LEADING \b. Without it, "L\.?E\.?\b" collapses into matching
  // any bare "le" substring followed by a word boundary — which fires
  // inside completely ordinary English words like "available", "sale",
  // "table", "sample", "incredible" (anything ending "-le "). Since EGP is
  // the very first pattern checked, a USD/EUR/GBP price sitting anywhere
  // near one of those common words got its currency silently misdetected
  // as EGP, was grouped into the EGP bucket, and then "converted" using an
  // EGP exchange rate it never actually had — a direct, high-frequency
  // mechanism for producing nonsense mixed-currency ranges. Adding the
  // leading \b restores the intended "L.E." / "S.R." / "K.D." abbreviation
  // matching (still allowing "L.E.", "LE", "L.E", etc.) while requiring it
  // to start at a word boundary, not mid-word.
  { code: "EGP", regex: /(E£|EGP|\bL\.?E\.?\b|ج\.م|جنيه\s*مصري|جنيه)/i },
  { code: "SAR", regex: /(SAR|\bS\.?R\.?\b|ر\.س|ريال\s*سعودي)/i },
  { code: "AED", regex: /(AED|\bDHS\b|د\.إ|درهم\s*إماراتي|درهم)/i },
  { code: "KWD", regex: /(KWD|\bK\.?D\.?\b|د\.ك|دينار\s*كويتي)/i },
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

// ============================================================================
// STEP 0 -- Mask the product's own model number(s) out of the search text
// ============================================================================
//
// BUG THIS FIXES: product names routinely contain bare numbers that look
// exactly like prices once a currency word happens to land inside the scan
// window ("iPhone 15 Pro Max" -> "15" is a model number, not money). This is
// especially common in Arabic listings where the price is stated BEFORE the
// product name ("...50,000 جنيه - آيفون 15 برو ماكس"), which puts "جنيه"
// within CURRENCY_WINDOW_CHARS of the "15" that belongs to the product
// name, not the price. If that's the only number that survives the
// pipeline, marketFairPriceMin/Mid/Max all collapse to that one bogus value
// (e.g. "15-15 EGP" for a phone actually listed around 50,000 EGP).
//
// Fix: parse the product name out of the prompt (the "PRODUCT: ..." line
// built by analyze.ts) and blank out every digit inside any occurrence of
// that exact phrase, in every Tavily result's text, BEFORE number
// extraction ever runs. Real prices elsewhere in the text are untouched.
function extractProductName(productQuery: string | undefined): string | null {
  if (!productQuery) return null;
  const m = /PRODUCT:\s*(.+)/i.exec(productQuery);
  const name = m ? m[1].trim() : null;
  if (!name) return null;
  return name.length >= 2 ? name : null;
}

function maskProductModelNumbers(text: string, productName: string | null): string {
  if (!productName) return text;
  const tokens = productName
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (tokens.length === 0) return text;
  const pattern = tokens.join("\\s+");
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    return text;
  }
  return text.replace(re, (match) => match.replace(/\d/g, "#"));
}

// ============================================================================
// STEP 0.5 — Product variant matching (storage capacity + trim suffix)
// ============================================================================
//
// BUG FOUND: this entire step did not exist. Nothing anywhere in the
// pipeline checked whether a Tavily result was actually about the SAME
// storage tier / trim the user searched for. Searching "Samsung Galaxy S24
// Ultra 256GB" would happily pool prices from 256GB, 512GB, and 1TB
// listings — and separately from S24, S24+, and S24 FE listings — into one
// currency bucket, because nothing ever looked past "does this text contain
// a number next to a currency marker that isn't obviously noise". Those are
// all individually "valid" prices, just for the wrong product, so no amount
// of keyword filtering or IQR outlier removal could ever catch them: a
// 512GB price is not a statistical outlier next to other 512GB prices, it's
// just wrong for a 256GB search. This is the direct mechanism behind
// "14,694 EGP -> 40,269 EGP" (a spread across storage tiers/trims, not a
// spread within one real market).
//
// Fix: before any number is even extracted, drop whole Tavily results whose
// title/lead content clearly indicate a CONFLICTING storage size or trim
// suffix and do not also mention the one the user asked for. Deliberately
// conservative: a result that simply doesn't mention storage/trim at all is
// left alone (ambiguous != wrong), so this only removes results that
// affirmatively point at a different variant.

interface VariantConstraints {
  requestedStorageGB: number | null;
  requestedSuffix: string | null; // e.g. "ultra", "plus", "pro max", or null for a bare base model
}

// Ordered most-specific-first so "Pro Max" is never mistaken for a bare
// "Pro", and "Ultra" isn't confused with a differently-named trim.
const VARIANT_SUFFIX_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "pro max", regex: /\bpro\s*max\b/i },
  { name: "ultra", regex: /\bultra\b/i },
  { name: "plus", regex: /\bplus\b|\d\+(?!\d)/i }, // "Plus" or a bare "S24+"-style glued plus
  { name: "pro", regex: /\bpro\b/i },
  { name: "max", regex: /\bmax\b/i },
  { name: "fe", regex: /\bfe\b/i },
  { name: "mini", regex: /\bmini\b/i },
  { name: "se", regex: /\bse\b/i },
  { name: "note", regex: /\bnote\b/i },
  { name: "air", regex: /\bair\b/i },
  { name: "lite", regex: /\blite\b/i },
];

function detectVariantSuffix(text: string): string | null {
  for (const { name, regex } of VARIANT_SUFFIX_PATTERNS) {
    if (regex.test(text)) return name;
  }
  return null;
}

function extractStorageGB(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(TB|GB)\b/i.exec(text);
  if (!m) return null;
  const num = parseFloat(m[1]);
  return m[2].toUpperCase() === "TB" ? num * 1024 : num;
}

function extractVariantConstraints(productName: string | null): VariantConstraints {
  if (!productName) return { requestedStorageGB: null, requestedSuffix: null };
  return {
    requestedStorageGB: extractStorageGB(productName),
    requestedSuffix: detectVariantSuffix(productName),
  };
}

// How much of a result's text to scan for variant signals — title plus a
// short lead-in of content, mirroring how these pages actually state the
// variant (in the headline), not deep in unrelated page boilerplate.
const VARIANT_SCAN_CHARS = 300;

function resultConflictsWithVariant(
  result: TavilyResultForPricing,
  constraints: VariantConstraints
): string | null {
  if (constraints.requestedStorageGB === null && constraints.requestedSuffix === null) return null;
  const headline = `${result.title} ${result.content.slice(0, VARIANT_SCAN_CHARS)}`;

  if (constraints.requestedStorageGB !== null) {
    const storageMatches = [...headline.matchAll(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/gi)];
    if (storageMatches.length > 0) {
      const foundGBs = storageMatches.map((m) =>
        m[2].toUpperCase() === "TB" ? parseFloat(m[1]) * 1024 : parseFloat(m[1])
      );
      const hasRequested = foundGBs.some((gb) => Math.abs(gb - constraints.requestedStorageGB!) < 0.01);
      const hasConflicting = foundGBs.some((gb) => Math.abs(gb - constraints.requestedStorageGB!) >= 0.01);
      if (hasConflicting && !hasRequested) {
        return `storage-mismatch (page mentions ${foundGBs.join("/")}GB, requested ${constraints.requestedStorageGB}GB)`;
      }
    }
  }

  const pageSuffix = detectVariantSuffix(headline);
  if (pageSuffix !== null && pageSuffix !== constraints.requestedSuffix) {
    return constraints.requestedSuffix === null
      ? `variant-mismatch (page is about the "${pageSuffix}" trim, requested the base model)`
      : `variant-mismatch (page is about the "${pageSuffix}" trim, requested "${constraints.requestedSuffix}")`;
  }

  return null;
}

// ---- Offered-price sanity floor -------------------------------------------
// Parses the "OFFERED PRICE: <number> <currency>" line (also built by
// analyze.ts's buildPrompt) so the final computed range can be sanity
// checked against what the user is actually being asked to pay. A "fair
// price" of 1% or less of the offered price is essentially never real
// market data -- it's almost always leftover extraction noise (a spec
// number, a model number, a rating count, etc.) -- so treating it as
// "no reliable price found" is far safer than shipping a nonsense range.
interface OfferedPriceHint {
  value: number;
  currency: SupportedCurrency;
}

function extractOfferedPriceHint(productQuery: string | undefined): OfferedPriceHint | null {
  if (!productQuery) return null;
  const m = /OFFERED PRICE:\s*([\d,.]+)\s*([A-Za-z]{2,4})/i.exec(productQuery);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ""));
  const currencyRaw = m[2].toUpperCase();
  if (!isFinite(value) || value <= 0 || !isSupportedCurrency(currencyRaw)) return null;
  return { value, currency: currencyRaw as SupportedCurrency };
}


// Matches numbers like "58,999", "1,050.50", "999" — but not bare digits
// glued to letters (so "128GB" alone still won't match without a currency
// marker nearby, since the caller requires one).
const NUMBER_PATTERN = /\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

const MIN_PLAUSIBLE_PRICE = 1;
const MAX_PLAUSIBLE_PRICE = 20_000_000;
const CURRENCY_WINDOW_CHARS = 15; // how far to look for a currency marker
const CONTEXT_WINDOW_CHARS = 60; // how far to look for noise keywords
const NEAR_PREFIX_WINDOW_CHARS = 22; // tighter window for generic prefixes like "from"/"up to"

export interface RawPriceHit {
  value: number;
  currency: SupportedCurrency;
  source: string; // result title, for logging
  url: string; // result URL, for source-trust weighting
  context: string; // text window around the match, for keyword filtering + logs
}

// Scans one piece of text for "number with a currency symbol/code within
// ~15 chars" pairs. A number with no nearby currency marker is ignored —
// this is what keeps specs like "128GB" or "5000mAh" from being misread as
// prices.
function collectRawPricesFromOneText(text: string, source: string, url: string): RawPriceHit[] {
  const found: RawPriceHit[] = [];
  const re = new RegExp(NUMBER_PATTERN);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const idx = m.index;

    // BUG FOUND: a bare percentage ("Save 20%") right before/after a price
    // in the same sentence ("Save 20% ($199)") put a currency marker within
    // CURRENCY_WINDOW_CHARS of the "20", so "20" was extracted as if it were
    // a price in its own right. Reject any number immediately followed by
    // "%" (optionally after whitespace) before doing anything else with it.
    const immediatelyAfter = text.slice(idx + raw.length, idx + raw.length + 2);
    if (/^\s*%/.test(immediatelyAfter)) continue;

    const currencyBefore = text.slice(Math.max(0, idx - CURRENCY_WINDOW_CHARS), idx);
    const currencyAfter = text.slice(idx + raw.length, idx + raw.length + CURRENCY_WINDOW_CHARS);
    const currency = detectCurrencyInWindow(currencyBefore) ?? detectCurrencyInWindow(currencyAfter);
    if (!currency) continue;

    const value = parseFloat(raw.replace(/[,\s]/g, ""));
    if (!isFinite(value) || value < MIN_PLAUSIBLE_PRICE || value > MAX_PLAUSIBLE_PRICE) continue;

    const contextBefore = text.slice(Math.max(0, idx - CONTEXT_WINDOW_CHARS), idx);
    const contextAfter = text.slice(idx + raw.length, idx + raw.length + CONTEXT_WINDOW_CHARS);

    found.push({
      value,
      currency,
      source,
      url,
      context: `${contextBefore}[${raw}]${contextAfter}`,
    });
  }
  return found;
}

// Kept for backwards compatibility / simple callers that just want
// {value, currency} pairs out of a single blob of text (no source
// weighting or keyword filtering applied).
export interface DetectedPrice {
  value: number;
  currency: SupportedCurrency;
}

export function collectPricesFromText(text: string): DetectedPrice[] {
  return collectRawPricesFromOneText(text, "", "").map((h) => ({ value: h.value, currency: h.currency }));
}

// ============================================================================
// STEP 2 — Discard prices that are not the actual product selling price
// ============================================================================
//
// Two tiers of keyword checks:
//  - WIDE keywords (financing, accessories, shipping, subscriptions, ...):
//    checked anywhere in a ~60-char window around the number, since these
//    phrases can legitimately sit a few words away ("Trade in your old
//    phone and this iPhone 15 Pro Max is only $699").
//  - NEAR-PREFIX keywords ("from", "up to", "starting at", "starting from"):
//    these are common English words that would cause heavy false-positive
//    rejection if matched anywhere in a wide window (e.g. "available from
//    Amazon for $999"), so they're only rejected when they sit immediately
//    before the number.

// Every keyword below is checked in BOTH English and Arabic. This matters a
// lot for this product: EGP/SAR/AED/KWD/QAR/BHD/OMR/JOD listings (Noon,
// Jarir, Amazon.eg/.sa, 2b, Btech, Carrefour Egypt/UAE, etc.) are very
// often in Arabic, and an English-only keyword list would silently let
// every Arabic-language trade-in/installment/accessory/shipping price
// straight through the filter — which is exactly how a real product price
// range like "55,000-75,000 EGP" ends up polluted down to something like
// "14,694-40,269 EGP" (a stray Arabic "قسط شهري"/"جراب"/"شحن" style price
// slipping in unfiltered).
const WIDE_REJECT_KEYWORDS: { reason: string; regex: RegExp }[] = [
  { reason: "trade-in", regex: /trade[\s-]?in|استبدال|تقييم\s*الاستبدال|استرداد\s*الجهاز/i },
  { reason: "financing", regex: /financ(e|ing)|تمويل/i },
  { reason: "monthly/per-month", regex: /(\/\s*mo\b|\/\s*month\b|per\s+month|monthly)|شهري(ا|ًا)?|بالشهر|قسط\s*شهري|شهر\/|\/شهر/i },
  { reason: "installment", regex: /install?ment|تقسيط|أقساط|اقساط/i },
  { reason: "coupon", regex: /coupon|كوبون|كود\s*خصم/i },
  { reason: "discount", regex: /discount|خصم|تخفيض/i },
  { reason: "save-amount", regex: /\bsave\b|توفير|وفر\b/i },
  { reason: "shipping", regex: /shipping|delivery\s+fee|شحن|مصاريف\s*الشحن|رسوم\s*التوصيل/i },
  { reason: "tax", regex: /\btax(es)?\b|ضريبة|ضرائب/i },
  { reason: "applecare", regex: /apple\s?care/i },
  { reason: "insurance", regex: /insurance|تأمين/i },
  { reason: "case/cover", regex: /\b(case|cover)\b|جراب|كفر|غطاء/i },
  { reason: "charger/adapter/cable", regex: /\b(charger|adapter|cable)\b|شاحن|محول|كابل/i },
  { reason: "screen-protector", regex: /screen\s?protector|حماية\s*شاشة|واقي\s*شاشة/i },
  { reason: "accessory/bundle", regex: /\b(accessor(y|ies)|bundle)\b|إكسسوار|اكسسوار|حزمة/i },
  { reason: "gift-card", regex: /gift\s?card|بطاقة\s*هدية|كارت\s*هدية/i },
  { reason: "auction/bid", regex: /\b(auction|bid)\b|مزاد|مزايدة/i },
  { reason: "deposit/reservation", regex: /\b(deposit|reservation)\b|عربون|حجز/i },
  { reason: "membership/subscription", regex: /\b(membership|subscription)\b|عضوية|اشتراك/i },
  { reason: "repair/replacement", regex: /\b(repair|replacement)\b|إصلاح|صيانة/i },
  // BUG FOUND: none of the six below existed at all before this fix, despite
  // being explicitly called out as common non-price noise. Each is a real,
  // observed source of "$1 ... $2,899"-style impossible ranges: a financing
  // widget quoting "$1/day" or "0% EMI" sits right next to a currency
  // symbol, passes every other filter, and (because it's numerically so far
  // from the real price) can still survive IQR fencing when the sample is
  // small — see the new absolute median-ratio guard in removeOutliers below
  // for the second layer of defense against exactly this.
  { reason: "EMI", regex: /\bEMI\b|قسط(?!\s*شهري)/i },
  { reason: "cashback", regex: /cash\s?back|كاش\s*باك|استرداد\s*نقدي/i },
  { reason: "per-day financing", regex: /(\/\s*day\b|per\s+day\b|as\s+low\s+as)|يوميا(ً)?|باليوم/i },
];

// Review/rating counts ("4.5 stars, 1,234 reviews") get their own narrow,
// close-proximity check rather than the WIDE 60-char list above: a page
// TITLE containing the word "review" (e.g. "iPhone 15 Pro Max review") is
// extremely common and sits well within the 60-char wide window of any
// price appearing early in that page's content, which would otherwise
// reject a perfectly legitimate price just because of its own title. Only
// reject when the keyword sits immediately next to the number itself.
const REVIEW_RATING_NEAR_WINDOW_CHARS = 12;
const REVIEW_RATING_KEYWORD_REGEX = /\b(reviews?|ratings?|stars?)\b|out\s+of\s+5|تقييم(ات)?|مراجع(ة|ات)|نجوم/i;

// "from" / "up to" / "starting at" / "starting from" — only rejected when
// immediately preceding the number, to avoid nuking legitimate hits like
// "in stock at Amazon for $999". Same caution applied to the Arabic
// equivalents: bare "من" (a generic preposition) is deliberately excluded
// since it would false-positive-reject far too often; only the unambiguous
// multi-word forms are matched.
const NEAR_PREFIX_REJECT_KEYWORDS: { reason: string; regex: RegExp }[] = [
  { reason: "starting-at/from", regex: /(starting\s+(at|from)|up\s+to|\bfrom\b|يبدأ\s*من|ابتداء(ً)?\s*من|حتى|وصولا(ً)?\s*إلى)\s*$/i },
];

// "Used" pricing is only noise if the product being searched for is NOT
// itself a used/refurbished/second-hand listing.
const USED_KEYWORD_REGEX = /\bused\b(?!\s*for)|مستعمل(ة)?|مجدد(ة)?/i;

function isProductSearchForUsedItem(productQuery: string | undefined): boolean {
  if (!productQuery) return false;
  return /\b(used|refurbished|second[\s-]?hand|renewed|pre[\s-]?owned)\b|مستعمل|مجدد/i.test(productQuery);
}

export interface RejectedPrice extends RawPriceHit {
  reason: string;
}

function applyKeywordFilter(
  hits: RawPriceHit[],
  productQuery: string | undefined
): { kept: RawPriceHit[]; rejected: RejectedPrice[] } {
  const kept: RawPriceHit[] = [];
  const rejected: RejectedPrice[] = [];
  const searchIsForUsedItem = isProductSearchForUsedItem(productQuery);

  for (const hit of hits) {
    const before = hit.context.slice(0, hit.context.indexOf("["));
    let rejectReason: string | null = null;

    for (const { reason, regex } of WIDE_REJECT_KEYWORDS) {
      if (regex.test(hit.context)) {
        rejectReason = reason;
        break;
      }
    }

    if (!rejectReason) {
      for (const { reason, regex } of NEAR_PREFIX_REJECT_KEYWORDS) {
        const nearBefore = before.slice(Math.max(0, before.length - NEAR_PREFIX_WINDOW_CHARS));
        if (regex.test(nearBefore)) {
          rejectReason = reason;
          break;
        }
      }
    }

    if (!rejectReason) {
      const after = hit.context.slice(hit.context.indexOf("]") + 1);
      const nearBefore = before.slice(Math.max(0, before.length - REVIEW_RATING_NEAR_WINDOW_CHARS));
      const nearAfter = after.slice(0, REVIEW_RATING_NEAR_WINDOW_CHARS);
      if (REVIEW_RATING_KEYWORD_REGEX.test(nearBefore) || REVIEW_RATING_KEYWORD_REGEX.test(nearAfter)) {
        rejectReason = "review/rating count";
      }
    }

    if (!rejectReason && !searchIsForUsedItem && USED_KEYWORD_REGEX.test(hit.context)) {
      rejectReason = "used-listing (searched product is not used)";
    }

    if (rejectReason) {
      rejected.push({ ...hit, reason: rejectReason });
    } else {
      kept.push(hit);
    }
  }

  return { kept, rejected };
}

// ============================================================================
// STEP 3 — Weight prices by source trust
// ============================================================================
//
// Higher confidence sources (official manufacturer/brand stores, and large
// well-known retailers active in the region) get a higher weight so they
// pull the final computed range toward themselves. Weight is used to
// duplicate a value's influence when computing quartiles/median — never to
// simply pick "the highest weight source's number" outright, since a single
// source can still be wrong.

const TRUSTED_RETAILER_WEIGHT = 3; // Apple, Amazon, Best Buy, B&H, Noon, Jarir, Extra, Samsung, official stores...
const RECOGNIZED_MARKETPLACE_WEIGHT = 2; // other well-known marketplaces
const DEFAULT_WEIGHT = 1; // unknown/unrecognized domains

const TRUSTED_RETAILER_DOMAINS = [
  "apple.com",
  "amazon.com",
  "amazon.eg",
  "amazon.sa",
  "amazon.ae",
  "bestbuy.com",
  "bhphotovideo.com",
  "noon.com",
  "jarir.com",
  "extra.com",
  "samsung.com",
  "samsungstore.com",
  "carrefouregypt.com",
  "carrefouruae.com",
];

const RECOGNIZED_MARKETPLACE_DOMAINS = [
  "ebay.com",
  "aliexpress.com",
  "walmart.com",
  "newegg.com",
  "2b.com.eg",
  "btech.com",
  "raya.com",
];

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function weightForUrl(url: string): number {
  const host = domainOf(url);
  if (!host) return DEFAULT_WEIGHT;
  if (TRUSTED_RETAILER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`) || host.includes(d))) {
    return TRUSTED_RETAILER_WEIGHT;
  }
  if (RECOGNIZED_MARKETPLACE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`) || host.includes(d))) {
    return RECOGNIZED_MARKETPLACE_WEIGHT;
  }
  return DEFAULT_WEIGHT;
}

interface WeightedPrice extends RawPriceHit {
  weight: number;
}

// ============================================================================
// STEP 4 — Remove statistical outliers (median / IQR, never Math.min/max)
// ============================================================================

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

function median(sortedValues: number[]): number {
  const n = sortedValues.length;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

// Expands each price into `weight` copies for quartile/median purposes, so
// trusted-source prices count more toward the "typical" value without
// letting any single source dictate the range outright.
function expandByWeight(prices: WeightedPrice[]): number[] {
  const expanded: number[] = [];
  for (const p of prices) {
    const times = Math.max(1, Math.round(p.weight));
    for (let i = 0; i < times; i++) expanded.push(p.value);
  }
  return expanded.sort((a, b) => a - b);
}

export interface OutlierResult {
  kept: WeightedPrice[];
  removed: (WeightedPrice & { reason: string })[];
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  lowerBound: number | null;
  upperBound: number | null;
}

// Standard median/IQR outlier removal (1.5x IQR fences). For very small
// samples (< 4 distinct values) IQR is unreliable/degenerate, so a
// multiplicative fallback around the median is used instead — still never
// a bare Math.min()/Math.max() pick.
function removeOutliers(prices: WeightedPrice[]): OutlierResult {
  if (prices.length === 0) {
    return { kept: [], removed: [], q1: null, q3: null, iqr: null, lowerBound: null, upperBound: null };
  }
  if (prices.length === 1) {
    return { kept: [...prices], removed: [], q1: null, q3: null, iqr: null, lowerBound: null, upperBound: null };
  }

  const distinctValues = new Set(prices.map((p) => p.value));
  const expanded = expandByWeight(prices);

  if (distinctValues.size < 4) {
    // Small-sample fallback: reject anything more than 3x away from the
    // median in either direction (catches stray "$1" / "$29" style noise
    // that slipped past keyword filtering without over-trimming a
    // legitimately tight 2-3 value sample).
    const med = median(expanded);
    const kept: WeightedPrice[] = [];
    const removed: (WeightedPrice & { reason: string })[] = [];
    for (const p of prices) {
      if (p.value > med / 3 && p.value < med * 3) {
        kept.push(p);
      } else {
        removed.push({ ...p, reason: `outlier (small-sample median guard, median=${med.toFixed(2)})` });
      }
    }
    // Never trim everything away in the fallback path.
    if (kept.length === 0) return { kept: [...prices], removed: [], q1: null, q3: null, iqr: null, lowerBound: null, upperBound: null };
    return { kept, removed, q1: null, q3: null, iqr: null, lowerBound: null, upperBound: null };
  }

  const q1 = percentile(expanded, 0.25);
  const q3 = percentile(expanded, 0.75);
  const iqr = q3 - q1;
  // BUG FOUND: with a small number of distinct points (which is the common
  // case here — usually 4-8 Tavily results), the 1.5x IQR fence can be
  // extremely permissive. Example: [1, 800, 1200, 2899] gives a lower fence
  // of roughly -936, so the stray "$1" (almost certainly a "$1/day"
  // financing figure or similar noise that slipped past every keyword
  // filter) is never flagged as an IQR outlier at all — it's what produced
  // "1 USD -> 2,899 USD". IQR fencing has no concept of an absolute floor
  // relative to the group's own center, so it's blind to this. Fix: also
  // enforce a hard ratio-to-median guard as a second, independent check —
  // any value less than 15% or more than 6x the group median is dropped
  // regardless of where the IQR fence lands. This never fires on a
  // legitimately tight real-world price spread (a genuine market range
  // rarely spans more than 6x low-to-high for the *same* SKU/variant), but
  // reliably catches leftover extraction noise.
  const med = median(expanded);
  const MEDIAN_RATIO_FLOOR = 0.15;
  const MEDIAN_RATIO_CEILING = 6;
  const lowerBound = Math.max(q1 - 1.5 * iqr, med * MEDIAN_RATIO_FLOOR);
  const upperBound = Math.min(q3 + 1.5 * iqr, med * MEDIAN_RATIO_CEILING);

  const kept: WeightedPrice[] = [];
  const removed: (WeightedPrice & { reason: string })[] = [];
  for (const p of prices) {
    if (p.value >= lowerBound && p.value <= upperBound) {
      kept.push(p);
    } else {
      removed.push({ ...p, reason: `outlier (outside [${lowerBound.toFixed(2)}, ${upperBound.toFixed(2)}] IQR+median-ratio fence, median=${med.toFixed(2)})` });
    }
  }

  // Guard against IQR collapsing to 0 (e.g. most values identical) and
  // wiping out every legitimately-different price — if that happens, fall
  // back to keeping everything rather than returning nothing.
  if (kept.length === 0) return { kept: [...prices], removed: [], q1, q3, iqr, lowerBound, upperBound };

  return { kept, removed, q1, q3, iqr, lowerBound, upperBound };
}

// ============================================================================
// STEP 5 — Compute marketFairPriceMin/Mid/Max from the surviving prices
// ============================================================================

export interface MarketPriceRange {
  min: number;
  mid: number;
  max: number;
  targetCurrency: SupportedCurrency;
  sourceCurrency: SupportedCurrency; // currency the raw prices were found in
  rate: number; // 1 sourceCurrency = `rate` targetCurrency
  sampleSize: number; // number of distinct listings that survived filtering
  sampleValues: number[]; // the individual surviving prices, already converted & sorted — given to the model as transparency, not just the aggregate min/mid/max
}

function buildRange(
  kept: WeightedPrice[],
  targetCurrency: SupportedCurrency,
  sourceCurrency: SupportedCurrency,
  rate: number
): MarketPriceRange {
  const rawValues = kept.map((p) => p.value).sort((a, b) => a - b);
  const min = Math.round(rawValues[0] * rate);
  const max = Math.round(rawValues[rawValues.length - 1] * rate);
  const weightedExpanded = expandByWeight(kept);
  const mid = Math.round(median(weightedExpanded) * rate);
  const sampleValues = [...new Set(rawValues)].map((v) => Math.round(v * rate));
  return { min, mid, max, targetCurrency, sourceCurrency, rate, sampleSize: kept.length, sampleValues };
}

// ============================================================================
// STEP 6 — Currency conversion (only ever applied AFTER filtering above)
// ============================================================================

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

// ============================================================================
// Putting it all together (Steps 1-7)
// ============================================================================

export interface TavilyResultForPricing {
  title: string;
  url: string;
  content: string;
  rawContent?: string | null;
}

// Main entry point. Give it the raw Tavily results (title + url + content)
// plus the currency the user asked for, and it returns a normalized
// min/mid/max already in that currency — extracting, keyword-filtering,
// source-weighting, outlier-removing, and ONLY THEN currency-converting.
// Returns null when no usable product price survives the pipeline (Step 7)
// — never a fake/garbage range.
export async function computeMarketPriceRange(
  tavilyResults: TavilyResultForPricing[],
  targetCurrencyRaw: string,
  productQuery?: string
): Promise<MarketPriceRange | null> {
  if (!isSupportedCurrency(targetCurrencyRaw)) return null;
  const targetCurrency = targetCurrencyRaw.toUpperCase() as SupportedCurrency;

  // ---- Step 0: mask the product's own model number(s) so they can never
  // be misread as a price (see maskProductModelNumbers above) ----
  const productName = extractProductName(productQuery);
  if (productName) {
    console.log(`[PriceExtraction] Step 0 — masking model-number occurrences of "${productName}" before scanning.`);
  }

  // ---- Step 0.5: drop results about a conflicting storage tier / trim ----
  const variantConstraints = extractVariantConstraints(productName);
  console.log(
    `[PriceExtraction] Step 0.5 — requested variant: storage=${variantConstraints.requestedStorageGB ?? "any"}GB, suffix=${variantConstraints.requestedSuffix ?? "base/none"}.`
  );
  const variantMatchedResults: TavilyResultForPricing[] = [];
  for (const r of tavilyResults) {
    const conflict = resultConflictsWithVariant(r, variantConstraints);
    if (conflict) {
      console.log(`[PriceExtraction] Step 0.5 — dropping result "${r.title}" (${r.url}) — ${conflict}`);
    } else {
      variantMatchedResults.push(r);
    }
  }
  console.log(
    `[PriceExtraction] Step 0.5 — kept ${variantMatchedResults.length}/${tavilyResults.length} result(s) after variant matching.`
  );
  if (variantMatchedResults.length === 0) {
    console.log("[PriceExtraction] Every result conflicted with the requested variant. Returning null.");
    return null;
  }

  // ---- Step 1: extract every possible money value ----
  const rawHits: RawPriceHit[] = [];
  for (const r of variantMatchedResults) {
    // Tavily's curated `content` snippet can end before the actual price
    // (common on regional Arabic listing pages). `rawContent`, when
    // present, is the fuller page scrape — scan a capped slice of it too
    // so a price further down the page isn't missed. Capped to keep this
    // fast and avoid pulling in unrelated boilerplate from very long pages.
    const RAW_CONTENT_SCAN_CHARS = 4000;
    const combinedText = `${r.title} ${r.content} ${(r.rawContent || "").slice(0, RAW_CONTENT_SCAN_CHARS)}`;
    const maskedText = maskProductModelNumbers(combinedText, productName);
    rawHits.push(...collectRawPricesFromOneText(maskedText, r.title, r.url));
  }
  console.log(`[PriceExtraction] Step 1 — extracted ${rawHits.length} raw price candidate(s).`);
  if (rawHits.length === 0) {
    console.log("[PriceExtraction] No price-like values found at all. Returning null.");
    return null;
  }

  // ---- Step 2: discard noise (trade-in, financing, accessories, etc.) ----
  const { kept: keywordFiltered, rejected } = applyKeywordFilter(rawHits, productQuery);
  console.log(
    `[PriceExtraction] Step 2 — kept ${keywordFiltered.length}, rejected ${rejected.length} by keyword filter.`
  );
  for (const r of rejected) {
    console.log(`[PriceExtraction]   rejected ${r.value} ${r.currency} — reason: ${r.reason} — context: "${r.context}"`);
  }
  if (keywordFiltered.length === 0) {
    console.log("[PriceExtraction] Everything was rejected by keyword filtering. Returning null.");
    return null;
  }

  // ---- Step 3: weight by source trust ----
  const weighted: WeightedPrice[] = keywordFiltered.map((h) => ({ ...h, weight: weightForUrl(h.url) }));
  console.log(
    `[PriceExtraction] Step 3 — source weights: ${weighted
      .map((w) => `${domainOf(w.url) || "unknown"}=${w.weight}`)
      .join(", ")}`
  );

  // ---- Group by currency (needed before outlier removal + conversion) ----
  const byCurrency = new Map<SupportedCurrency, WeightedPrice[]>();
  for (const p of weighted) {
    const list = byCurrency.get(p.currency) ?? [];
    list.push(p);
    byCurrency.set(p.currency, list);
  }

  // Prefer the requested currency if it's directly present; otherwise use
  // whichever OTHER currency shows up most (by weighted count) as the
  // likely "real" source currency to convert from.
  let sourceCurrency: SupportedCurrency;
  let sourceGroup: WeightedPrice[];
  if (byCurrency.has(targetCurrency)) {
    sourceCurrency = targetCurrency;
    sourceGroup = byCurrency.get(targetCurrency)!;
  } else {
    const entries = [...byCurrency.entries()].sort(
      (a, b) => expandByWeight(b[1]).length - expandByWeight(a[1]).length
    );
    [sourceCurrency, sourceGroup] = entries[0];
  }

  // ---- Step 4: remove statistical outliers (median/IQR) within that group ----
  const outlierResult = removeOutliers(sourceGroup);
  console.log(
    `[PriceExtraction] Step 4 — outlier removal on ${sourceCurrency}: kept ${outlierResult.kept.length}, removed ${outlierResult.removed.length}` +
      (outlierResult.q1 !== null
        ? ` (Q1=${outlierResult.q1?.toFixed(2)}, Q3=${outlierResult.q3?.toFixed(2)}, IQR=${outlierResult.iqr?.toFixed(2)}, fence=[${outlierResult.lowerBound?.toFixed(2)}, ${outlierResult.upperBound?.toFixed(2)}])`
        : " (small-sample median-guard fallback used)")
  );
  for (const r of outlierResult.removed) {
    console.log(`[PriceExtraction]   removed outlier ${r.value} ${r.currency} — ${r.reason} (source: ${domainOf(r.url) || "unknown"})`);
  }
  console.log(
    `[PriceExtraction] Step 4 — remaining prices: ${outlierResult.kept.map((p) => p.value).join(", ")} ${sourceCurrency}`
  );

  if (outlierResult.kept.length === 0) {
    // Step 7: nothing valid survived — never fabricate a range.
    console.log("[PriceExtraction] Nothing survived outlier removal. Returning null.");
    return null;
  }

  // ---- Step 6: convert currencies AFTER filtering (never before) ----
  const rate = await getExchangeRate(sourceCurrency, targetCurrency);
  if (rate === null) {
    console.log(
      `[PriceExtraction] Could not obtain exchange rate ${sourceCurrency}->${targetCurrency}. Returning null.`
    );
    return null; // conversion genuinely impossible right now
  }

  // ---- Step 5: compute the final range ----
  const range = buildRange(outlierResult.kept, targetCurrency, sourceCurrency, rate);
  console.log(
    `[PriceExtraction] Step 5/6 — final range: min=${range.min} mid=${range.mid} max=${range.max} ${range.targetCurrency}` +
      (sourceCurrency !== targetCurrency ? ` (converted from ${sourceCurrency} at rate ${rate})` : " (no conversion needed)")
  );

  // ---- Final safety net: sanity-check against what the user is actually
  // being asked to pay. A "fair price" of 1% or less of the offered price
  // is essentially never real market data — it's almost always leftover
  // extraction noise (a spec number, model number, rating count, etc.)
  // that slipped through every earlier filter. Returning null here (which
  // the caller treats as "let the model fall back to its own reading") is
  // far safer than shipping a nonsense range like "15-15 EGP".
  const offeredHint = extractOfferedPriceHint(productQuery);
  if (offeredHint && offeredHint.currency === targetCurrency && range.max < offeredHint.value / 50) {
    console.log(
      `[PriceExtraction] Step 7 (sanity guard) — computed max ${range.max} ${targetCurrency} is under 1/50th of the offered price ${offeredHint.value} ${targetCurrency}. Discarding as extraction noise and returning null.`
    );
    return null;
  }

  return range;
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

  const sampleValuesNote =
    range.sampleValues.length > 0
      ? `Individual listing prices that survived filtering (already converted to ${range.targetCurrency}): ${range.sampleValues.join(", ")}.`
      : "";

  // PHILOSOPHY CHANGE: this used to tell the model to use these numbers
  // verbatim and never re-derive them ("do not re-derive, re-estimate, or
  // re-convert them yourself"). That made the backend's regex/keyword
  // pipeline the FINAL word even when it was wrong — and a fixed rule-based
  // pipeline can never anticipate every phrasing, site layout, or edge
  // case, unlike a model actually reading the page. This is also why the
  // old Gemini + Google Search grounding flow, which just let the model use
  // its own judgment on the raw search text, often produced a more sensible
  // "fair price" than a rigid pipeline can.
  //
  // The fix isn't to remove backend extraction (it catches far more noise,
  // far more consistently, than an LLM reading raw text top to bottom) —
  // it's to stop treating its output as unquestionable. The backend
  // calculation is now framed as a strong, pre-filtered REFERENCE the model
  // should anchor to by default, but the model is explicitly told to check
  // it against the actual search results and its own knowledge of the
  // product, and to adjust if the reference is clearly inconsistent with
  // what it's reading (e.g. wrong product variant slipped through, a
  // regional price spike, a stale listing). This keeps the pipeline's noise
  // filtering as the default anchor while restoring the model's ability to
  // catch what the pipeline couldn't.
  return `\n\nBACKEND-COMPUTED MARKET PRICE REFERENCE (a pre-filtered, outlier-cleaned, currency-converted calculation from the live search results above — treat it as your primary reference point, not as an unquestionable final answer):
- marketFairPriceMin: ${range.min} ${range.targetCurrency}
- marketFairPriceMid: ${range.mid} ${range.targetCurrency}
- marketFairPriceMax: ${range.max} ${range.targetCurrency}
${sourceNote}
${sampleValuesNote}
Use this reference calculation as your starting point for marketFairPriceMin/Mid/Max. Cross-check it against the search results above and your own knowledge of this product: if it clearly matches what you're seeing (right product, right variant, sane numbers), use it as-is. If you can see from the search results that it's wrong — e.g. it's mixing in the wrong storage/trim/model variant, an obviously stale or regional-outlier listing, or a number that doesn't make sense for this exact product — use your own judgment to produce a more accurate range instead, and mention briefly in your reasoning why you adjusted it. Do NOT return null/"unavailable" for these fields; real pricing data is available, either from this reference or from the search results directly.`;
}
