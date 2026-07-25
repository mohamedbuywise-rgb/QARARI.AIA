import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import {
  callAnalysisModel,
  getFairPriceRangeViaCompound,
  fetchMainProductRetailerLinks,
  attachLinksAndPricesToAlternatives,
  attachSearchLinksToAlternatives,
  getRegionForCurrency,
  type FairPriceRange,
} from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";
import { FREE_TIER_LIMITS, DEFAULT_PREMIUM_LIMITS } from "./_planConfig.js";

// Section 15: Use centralized config for free tier limits
const FREE_MONTHLY_LIMIT = FREE_TIER_LIMITS.scans;
const CACHE_TTL_HOURS = 72; // how long a cached market-research result stays valid for reuse

function normalizeCacheKey(product: string, currency: string, condition: string = "new", specs: string = ""): string {
  const normalizedProduct = product.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedCondition = condition.trim().toLowerCase();
  // specs (storage/RAM/size/color/etc.) must be part of the key — otherwise
  // "iPhone 13 Pro" @ 128GB and "iPhone 13 Pro" @ 256GB collide into the same
  // cached market-price result even though they're different products.
  const normalizedSpecs = specs.trim().toLowerCase().replace(/\s+/g, " ");
  return `${normalizedProduct}::${normalizedSpecs}::${normalizedCondition}::${currency.trim().toUpperCase()}`;
}

// ---- AI response shape validation/normalization ----
// There is no Zod schema anywhere in this backend (checked the whole repo) —
// the previous "validator" was just three inline `typeof` checks in the
// handler below, which threw away all detail and logged nothing but
// "AI response failed shape validation". This replaces that with:
//   1. a real field-by-field check that records exactly what was wrong, and
//   2. normalization that fills in safe defaults for non-critical fields
//      instead of 502'ing the whole request over something like a missing
//      `hiddenRisks` array.
interface FieldIssue {
  field: string;
  expected: string;
  received: string;
  value: unknown;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// number OR null are both valid per the prompt ("marketFairPriceMin/Max/Mid":
// number | null — the model is told to return null when it has no reliable
// pricing signal instead of inventing a figure).
function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function bilingualStrings(v: any): { ar: string; en: string } {
  return {
    ar: typeof v?.ar === "string" ? v.ar : "",
    en: typeof v?.en === "string" ? v.en : "",
  };
}

function bilingualArrays(v: any): { ar: string[]; en: string[] } {
  return {
    ar: Array.isArray(v?.ar) ? v.ar : [],
    en: Array.isArray(v?.en) ? v.en : [],
  };
}

// Only these are treated as essential — everything else gets a safe default
// rather than failing the whole request. `verdict` and the three price
// fields are the ones the rest of the handler (moneySaved, verdict badge,
// etc.) actually depends on existing in some valid form.
function validateAndNormalizeAnalysis(parsed: any): { ok: true; data: any } | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({ field: "(root)", expected: "object", received: describeType(parsed), value: parsed });
    return { ok: false, issues };
  }

  if (typeof parsed.verdict !== "string" || !["good", "fair", "bad"].includes(parsed.verdict)) {
    issues.push({
      field: "verdict",
      expected: '"good" | "fair" | "bad"',
      received: describeType(parsed.verdict),
      value: parsed.verdict,
    });
  }

  for (const field of ["marketFairPriceMin", "marketFairPriceMax", "marketFairPriceMid"]) {
    if (!isNumberOrNull(parsed[field])) {
      issues.push({
        field,
        expected: "number | null",
        received: describeType(parsed[field]),
        value: parsed[field],
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // marketFairPriceMin/Max/Mid: normalize — ensure all three are number | null.
  // If the model returned a non-null mid, trust it. Otherwise compute from
  // min/max when both are available. This guarantees the UI never sees
  // undefined/missing values for any of the three.
  const marketFairPriceMin: number | null = isNumberOrNull(parsed.marketFairPriceMin) ? parsed.marketFairPriceMin : null;
  const marketFairPriceMax: number | null = isNumberOrNull(parsed.marketFairPriceMax) ? parsed.marketFairPriceMax : null;
  let marketFairPriceMid: number | null = parsed.marketFairPriceMid;
  if (!isNumberOrNull(marketFairPriceMid) || marketFairPriceMid === null) {
    marketFairPriceMid = marketFairPriceMin !== null && marketFairPriceMax !== null
      ? Math.round((marketFairPriceMin + marketFairPriceMax) / 2)
      : null;
  }

  // Non-critical fields: normalize to safe defaults instead of throwing 502.
  const data = {
    ...parsed,
    marketFairPriceMin,
    marketFairPriceMax,
    marketFairPriceMid,
    marketPriceSummary: bilingualStrings(parsed.marketPriceSummary),
    reasoningPoints: bilingualArrays(parsed.reasoningPoints),
    pros: bilingualArrays(parsed.pros),
    cons: bilingualArrays(parsed.cons),
    hiddenRisks: bilingualArrays(parsed.hiddenRisks),
    preRecommendation: bilingualStrings(parsed.preRecommendation),
    futureCompatibility: bilingualStrings(parsed.futureCompatibility),
    regretJustification: bilingualStrings(parsed.regretJustification),
    finalTip: bilingualStrings(parsed.finalTip),
    negotiationScript: bilingualStrings(parsed.negotiationScript),
    regretLevel: ["low", "medium", "high"].includes(parsed.regretLevel) ? parsed.regretLevel : "medium",
    betterAlternatives: Array.isArray(parsed.betterAlternatives) ? parsed.betterAlternatives : [],
    ...(parsed.negotiationScriptVariants
      ? {
          negotiationScriptVariants: {
            polite: bilingualStrings(parsed.negotiationScriptVariants?.polite),
            firm: bilingualStrings(parsed.negotiationScriptVariants?.firm),
          },
        }
      : {}),
    resaleValueRightNow: typeof parsed.resaleValueRightNow === "number" ? parsed.resaleValueRightNow : null,
    resaleValue2Years: typeof parsed.resaleValue2Years === "number" ? parsed.resaleValue2Years : null,
    resaleInsight: bilingualStrings(parsed.resaleInsight),
  };

  return { ok: true, data };
}

function buildPrompt(opts: {
  product: string;
  offeredPrice: number;
  currency: string;
  notes: string;
  purpose: string;
  duration: string;
  specs: string;
  condition: string;
  language: "ar" | "en";
  tier: "free" | "premium";
  marketPrice: FairPriceRange;
}) {
  const { product, offeredPrice, currency, notes, purpose, duration, specs, condition, tier, language, marketPrice } = opts;

  const depthInstruction =
    tier === "premium"
      ? `PREMIUM DEPTH REQUIRED:
- reasoningPoints: 3-4 fuller sentences each, with specific numbers (prices, percentages, timing).
- pros: 3-4 complete specific sentences (not short phrases).
- cons: 2-3 complete specific sentences (not short phrases).
- hiddenRisks: 3-4 specific, actionable items (seller verification, serial number checks, spec mismatches vs the stated usage profile).
- Also include "negotiationScriptVariants": { "polite": {"ar":"...","en":"..."}, "firm": {"ar":"...","en":"..."} } IN ADDITION to negotiationScript.`
      : `FREE TIER DEPTH:
- reasoningPoints: 2-3 short numbered points.
- pros: 2-4 short bullet phrases.
- cons: 2-3 short bullet phrases.
- hiddenRisks: 1-2 short risk strings.
- Do NOT include negotiationScriptVariants, only the single negotiationScript field.`;

  const marketPriceSummaryText = marketPrice.summary ? (language === "ar" ? marketPrice.summary.ar : marketPrice.summary.en) : null;

  return `You are a purchase-decision analyst producing a structured JSON analysis for this product.

PRODUCT: ${product}
OFFERED PRICE: ${offeredPrice} ${currency}
PRODUCT CONDITION: ${condition}
USER NOTES: ${notes || "none"}
USAGE PROFILE — purpose: ${purpose}, expected duration: ${duration}, other specs/preferences: ${specs || "none"}

MARKET PRICE DATA (already researched live for you by a separate pricing system — DO NOT recalculate or invent different numbers, just use these exact figures everywhere you need a price):
- marketFairPriceMin: ${marketPrice.min ?? "null"}
- marketFairPriceMax: ${marketPrice.max ?? "null"}
- marketFairPriceMid: ${marketPrice.mid ?? "null"}
${marketPriceSummaryText ? `- Research note: ${marketPriceSummaryText}` : "- No reliable pricing signal was found — treat both bounds as null."}

${depthInstruction}

Return a JSON object with EXACTLY this shape (all text fields must have both "ar" and "en" versions, natural fluent Arabic and English — not machine-translated):

{
  "verdict": "good" | "fair" | "bad",
  "marketFairPriceMin": number | null,
  "marketFairPriceMax": number | null,
  "marketFairPriceMid": number | null,
  "marketPriceSummary": { "ar": string, "en": string },
  "reasoningPoints": { "ar": string[], "en": string[] },
  "preRecommendation": { "ar": string, "en": string },
  "futureCompatibility": { "ar": string, "en": string },
  "regretLevel": "low" | "medium" | "high",
  "regretJustification": { "ar": string, "en": string },
  "pros": { "ar": string[], "en": string[] },
  "cons": { "ar": string[], "en": string[] },
  "hiddenRisks": { "ar": string[], "en": string[] },
  "finalTip": { "ar": string, "en": string },
  "betterAlternatives": [ { "name": string, "reason": {"ar":string,"en":string}, "whySuitable": {"ar":string,"en":string} } ],
  "negotiationScript": { "ar": string, "en": string }${tier === "premium" ? ',\n  "negotiationScriptVariants": { "polite": {"ar":string,"en":string}, "firm": {"ar":string,"en":string} }' : ""},
  "resaleValueRightNow": number | null,
  "resaleValue2Years": number | null,
  "resaleInsight": { "ar": string, "en": string }
}

Rules:
- marketFairPriceMin/marketFairPriceMax/marketFairPriceMid: COPY the exact numbers given above in "MARKET PRICE DATA" verbatim — do NOT recalculate, adjust, or invent a different figure. If they are given as null, return null.
- marketPriceSummary: write ONE analytical paragraph (2-4 sentences, natural fluent language, not a bullet list) that reads like a Google AI-generated search overview summarizing the current market price for this exact product — e.g. "بناءً على نتائج البحث، يتراوح سعر [المنتج] في السوق حالياً بين [الحد الأدنى] و[الحد الأقصى]، مع فرق واضح بين الجهاز الجديد والمستعمل/كسر الزيرو إن وُجد". Requirements for this paragraph:
  - State the current price range explicitly using the SAME marketFairPriceMin/Max numbers given above — never a different or rounder-sounding figure.
  - Use the research note given above (if any) as your source of what was found.
  - Do not invent figures: if marketFairPriceMin/Max are null, say plainly that no reliable current price was found instead of describing a range.
- verdict: "good" if offeredPrice < marketFairPriceMin, "fair" if within range, "bad" if above marketFairPriceMax (using the given numbers above). If the price fields are null, use "fair" unless other context clearly points elsewhere.
- All prices in ${currency}.
- betterAlternatives: return EXACTLY 4 items — not 3, not 5, always exactly 4. Suggest alternatives that are actually better value or similar in price, not 2x more expensive for no reason. Do NOT include a price for alternatives yourself — the app runs its own live research for each alternative afterward and attaches a real fair price range plus a direct listing link, so just focus on why each one is a good pick and what condition (${condition}) it should match.
- resaleValueRightNow: estimate what this product would sell for on the second-hand market RIGHT NOW (in ${currency}), based on brand reputation, current demand, and the offeredPrice of ${offeredPrice} ${currency}. Return null if no reliable data.
- resaleValue2Years: estimate what this product will be worth on the second-hand market in 2 years from now. Return null if no reliable data.
- resaleInsight: a bilingual text with a brief insight about the resale value of this product. E.g. in Arabic: "آبل بتحتفظ بقيمة عالية جداً في السوق، بعد سنتين ممكن تبيعه بـ 55% من سعره" and in English: "Apple retains value well in the market, after 2 years you can sell for ~55% of current price."
- Return ONLY the JSON object, nothing else.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);
  logEnvPresence({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (req.method !== "POST") {
    console.warn("[/api/analyze] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const {
      product,
      offeredPrice,
      currency,
      notes = "",
      purpose = "personal",
      duration = "threePlusYears",
      specs = "",
      condition = "new",
      language = "ar",
      imageBase64, // optional: { data, mimeType }
    } = req.body || {};

    console.log("[/api/analyze] Validating input...");
    if (!product || typeof product !== "string" || !offeredPrice || Number(offeredPrice) <= 0) {
      console.warn("[/api/analyze] Invalid input:", { product, offeredPrice });
      return res.status(400).json({ error: "invalid_input" });
    }
    console.log("[/api/analyze] Input OK. product:", product, "| offeredPrice:", offeredPrice, "| currency:", currency);

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    let tier: "free" | "premium" = "free";
    let quotaOk = true;

    if (user) {
      // ---- SIGNED-IN USER: check/enforce quota tied to their account row ----
      console.log("[/api/analyze] Loading user row for quota check...");
      const { data: userRow, error: userErr } = await admin
        .from("users")
        .select("tier, subscription_end_date, scans_used_this_month, scans_reset_at")
        .eq("id", user.id)
        .single();

      if (userErr || !userRow) {
        console.error("[/api/analyze] user_not_found. Supabase error:", userErr);
        return res.status(404).json({ error: "user_not_found" });
      }
      console.log("[/api/analyze] User row loaded. tier:", userRow.tier, "| scansUsed:", userRow.scans_used_this_month);

      // Auto-revert to Free if subscription expired (Section 16)
      const now = new Date();
      let effectiveTier = userRow.tier;
      if (effectiveTier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
        effectiveTier = "free";
        await admin.from("users").update({ tier: "free" }).eq("id", user.id);
      }
      tier = effectiveTier as "free" | "premium";

      // Reset monthly counter if a new cycle has started
      const resetAt = new Date(userRow.scans_reset_at);
      const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
      let scansUsed = needsReset ? 0 : userRow.scans_used_this_month;
      if (needsReset) {
        await admin.from("users").update({ scans_used_this_month: 0, scans_reset_at: now.toISOString() }).eq("id", user.id);
      }

      // Section 15: Use dynamic limits from user row (stored when plan was activated)
      const scansLimit = tier === "premium" ? (userRow.scans_limit_this_month || DEFAULT_PREMIUM_LIMITS.scans) : FREE_MONTHLY_LIMIT;
      
      if (scansUsed >= scansLimit) {
        quotaOk = false;
      }

      if (!quotaOk) {
        console.warn("[/api/analyze] Quota exceeded for user:", user.id, "| tier:", tier);
        return res.status(403).json({ error: "quota_exceeded" });
      }
    } else {
      // ---- GUEST: track by IP address ----
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      console.log("[/api/analyze] Guest request. IP:", ip);

      const { data: guestRow } = await admin.from("guest_usage").select("*").eq("ip_address", ip).single();
      const now = new Date();

      let scansUsed = 0;
      if (guestRow) {
        const resetAt = new Date(guestRow.scans_reset_at);
        const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
        scansUsed = needsReset ? 0 : guestRow.scans_used_this_month;
      }

      if (scansUsed >= FREE_MONTHLY_LIMIT) {
        console.warn("[/api/analyze] Guest quota exceeded. IP:", ip, "| scansUsed:", scansUsed);
        return res.status(403).json({ error: "quota_exceeded" });
      }

      // Upsert guest usage row (incremented after a successful analysis, below)
      await admin.from("guest_usage").upsert({
        ip_address: ip,
        scans_used_this_month: scansUsed,
        scans_reset_at: guestRow ? guestRow.scans_reset_at : now.toISOString(),
        updated_at: now.toISOString(),
      });
    }

    // ---- Cache check (Section 25 cost-saving layer) ----
    // Popular products get scanned repeatedly by different users. Reuse the
    // same market-research result (same product + currency) within the TTL
    // window instead of paying for a brand-new Groq completion + Tavily
    // search call.
    console.log("Loading cache...");
    const cacheKey = normalizeCacheKey(product, currency, condition, specs);
    const cacheCutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

    const { data: cachedRow } = await admin
      .from("analysis_cache")
      .select("parsed, model_used, created_at")
      .eq("cache_key", cacheKey)
      .gte("created_at", cacheCutoff)
      .single();
    console.log("Cache loaded. Hit:", !!cachedRow, "| cacheKey:", cacheKey);

    let parsed: any;
    let modelUsed: string;

    if (cachedRow) {
      // Cache hit — skip the AI pipeline entirely, no token cost, no search cost.
      parsed = cachedRow.parsed;
      modelUsed = cachedRow.model_used;
      console.log("[/api/analyze] Using cached analysis. modelUsed:", modelUsed);
    } else {
      const cond: "new" | "likeNew" | "used" = condition === "used" ? "used" : condition === "likeNew" ? "likeNew" : "new";

      // ---- STEP 1: Groq Compound (background, invisible to the client) ----
      // Sole source of truth for the main product's fair price range. Runs
      // its own live web search internally — Serper plays no part in this.
      logStep("Calling Groq Compound for fair price range (background)...");
      const marketPrice: FairPriceRange = await getFairPriceRangeViaCompound(product, currency, cond, specs);
      console.log("[/api/analyze] Compound price range:", marketPrice.min, "-", marketPrice.max, "| mid:", marketPrice.mid);

      // ---- STEP 2: narrative analysis (verdict, reasoning, pros/cons,
      // hidden risks, alternatives, negotiation, resale) — given the
      // Compound price range as an already-researched fact, never asked to
      // recompute it itself. No Serper search happens in this call at all.
      const prompt = buildPrompt({ product, offeredPrice: Number(offeredPrice), currency, notes, purpose, duration, specs, condition, language, tier, marketPrice });

      let aiResult;
      try {
        logStep("Calling AI pipeline (narrative analysis)...");
        aiResult = await callAnalysisModel(prompt);
        console.log("[/api/analyze] AI pipeline succeeded. modelUsed:", aiResult.modelUsed, "| usage:", aiResult.usage);
      } catch (e: any) {
        // Section 10: both models failed — clear translated error, not a silent failure
        console.error("[/api/analyze] AI pipeline failed (both primary and fallback exhausted):");
        console.error(e);
        console.error(e?.stack);
        return res.status(502).json({ error: "analysis_failed", reason: e?.message });
      }

      parsed = aiResult.data;
      modelUsed = aiResult.modelUsed;

      // Compound is the sole source of truth for the main product's price —
      // enforce its numbers on the final result regardless of what the
      // narrative model echoed back.
      parsed.marketFairPriceMin = marketPrice.min;
      parsed.marketFairPriceMax = marketPrice.max;
      parsed.marketFairPriceMid = marketPrice.mid;
      console.log(`[/api/analyze] Compound market price enforced: min=${marketPrice.min}, max=${marketPrice.max}, mid=${marketPrice.mid} (was ${aiResult.data?.marketFairPriceMin}/${aiResult.data?.marketFairPriceMax}/${aiResult.data?.marketFairPriceMid} from narrative model)`);

      // ---- STEP 3: Serper's ONLY job — direct listing links (Jumia/Amazon/
      // Noon, optionally B.TECH) for the main product. Never used for
      // pricing. Stored on `parsed` so it rides along with the cached
      // analysis on future cache hits too.
      try {
        parsed.retailerPrices = await fetchMainProductRetailerLinks(product, currency, cond);
      } catch (e) {
        console.error("[/api/analyze] Building retailer search links failed (non-fatal):", e);
        parsed.retailerPrices = [];
      }

      // ---- STEP 4: exactly 4 alternatives, hard cap enforced here regardless
      // of what the model returned. Each gets Serper direct links + a
      // Compound-derived fair price range.
      if (Array.isArray(parsed.betterAlternatives)) {
        parsed.betterAlternatives = parsed.betterAlternatives.slice(0, 4);
      } else {
        parsed.betterAlternatives = [];
      }

      if (parsed.betterAlternatives.length > 0) {
        try {
          const region = getRegionForCurrency(currency);
          parsed.betterAlternatives = await attachLinksAndPricesToAlternatives(
            parsed.betterAlternatives,
            currency,
            region,
            cond
          );
        } catch (e) {
          console.error("[/api/analyze] Researching alternative prices failed (non-fatal):", e);
          parsed.betterAlternatives = attachSearchLinksToAlternatives(parsed.betterAlternatives, currency);
        }
      }

      // Section 25: log AI usage/cost for every real Groq call, win or lose downstream.
      console.log("Saving database...");
      await logAiUsage(admin, {
        endpoint: "analyze",
        model: aiResult.modelUsed,
        tier: user ? tier : "guest",
        userId: user?.id || null,
        usage: aiResult.usage,
      });

      // Store for future requests — best-effort, never blocks the response
      await admin.from("analysis_cache").upsert({
        cache_key: cacheKey,
        parsed,
        model_used: modelUsed,
        created_at: new Date().toISOString(),
      });
      console.log("Saving database... done");
    }

    // Field-level shape validation + normalization (see validateAndNormalizeAnalysis above).
    console.log(`[/api/analyze] Pre-validation: marketFairPriceMin=${parsed.marketFairPriceMin}, marketFairPriceMax=${parsed.marketFairPriceMax}, marketFairPriceMid=${parsed.marketFairPriceMid}`);
    const validation = validateAndNormalizeAnalysis(parsed);
    if (!validation.ok) {
      console.error("[/api/analyze] Validation failed");
      for (const issue of validation.issues) {
        console.error(
          `Field: ${issue.field}\nExpected: ${issue.expected}\nReceived: ${issue.received}\nValue: ${JSON.stringify(issue.value)}`
        );
      }
      console.error("Raw AI JSON:", JSON.stringify(parsed)?.slice(0, 4000));
      return res.status(502).json({
        error: "analysis_invalid",
        issues: validation.issues.map(({ field, expected, received }) => ({ field, expected, received })),
      });
    }
    parsed = validation.data;

    const marketFairPriceMid: number | null = parsed.marketFairPriceMid;
    const moneySaved = marketFairPriceMid === null ? null : Math.max(0, marketFairPriceMid - Number(offeredPrice));
    console.log(`[/api/analyze] Post-validation: marketFairPriceMin=${parsed.marketFairPriceMin}, marketFairPriceMax=${parsed.marketFairPriceMax}, marketFairPriceMid=${parsed.marketFairPriceMid}, moneySaved=${moneySaved}`);

    // ---- Community insights (Section 27 — REAL social proof, never fabricated) ----
    // Log this user's real offered price as an anonymous event, then look at
    // how many real events exist for the same product+currency. We only ever
    // surface genuine counts/ranges pulled from this table — if there isn't
    // enough real data yet, communityInsights comes back null and the UI
    // hides the widget instead of inventing a number.
    let communityInsights: {
      analyzedCount: number;
      recentPrices: number[];
    } | null = null;

    try {
      await admin.from("product_price_events").insert({
        cache_key: cacheKey,
        offered_price: Number(offeredPrice),
        currency,
      });

      const { count } = await admin
        .from("product_price_events")
        .select("*", { count: "exact", head: true })
        .eq("cache_key", cacheKey);

      const MIN_REAL_EVENTS_TO_SHOW = 3; // don't show a "community" stat for just 1-2 real data points

      if (count && count >= MIN_REAL_EVENTS_TO_SHOW) {
        const { data: recentEvents } = await admin
          .from("product_price_events")
          .select("offered_price")
          .eq("cache_key", cacheKey)
          .order("created_at", { ascending: false })
          .limit(5);

        communityInsights = {
          analyzedCount: count,
          recentPrices: (recentEvents || []).map((e: any) => Number(e.offered_price)),
        };
      }
    } catch (e) {
      // Best-effort only — never blocks or fails the actual analysis response.
      console.error("[/api/analyze] community insights failed:", e);
    }

    const result = {
      id: crypto.randomUUID(),
      product,
      offeredPrice: Number(offeredPrice),
      currency,
      condition,
      marketFairPriceMin: parsed.marketFairPriceMin,
      marketFairPriceMax: parsed.marketFairPriceMax,
      marketFairPriceMid,
      ...parsed,
      moneySaved,
      communityInsights,
      createdAt: Date.now(),
    };

    // ---- Record usage AFTER a successful analysis (never before) ----
    console.log("[/api/analyze] Recording usage...");
    if (user) {
      const { data: row } = await admin.from("users").select("scans_used_this_month").eq("id", user.id).single();
      await admin.from("users").update({ scans_used_this_month: (row?.scans_used_this_month || 0) + 1 }).eq("id", user.id);
    } else {
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      const { data: row } = await admin.from("guest_usage").select("scans_used_this_month").eq("ip_address", ip).single();
      await admin.from("guest_usage").update({ scans_used_this_month: (row?.scans_used_this_month || 0) + 1 }).eq("ip_address", ip);
    }

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json(result);
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({
      error: "server_error",
      // Debug-only fields — safe to keep during development since this is
      // additive info, not a change to the normal success-path response shape.
      message: err?.message,
      stack: err?.stack,
    });
  }
}
