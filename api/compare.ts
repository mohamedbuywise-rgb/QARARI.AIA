import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";

// Fair-use cap for paid subscribers — Compare used to be unlimited, but each
// comparison is a full Groq call with a Tavily search (same cost as a
// scan), so it needs the same kind of monthly ceiling /api/analyze enforces.
const COMPARE_MONTHLY_LIMIT = 10;

function buildComparePrompt(productA: string, productB: string, priceA: number, priceB: number, currency: string) {
  return `You are a purchase-decision analyst with real-time web search access. Research CURRENT real market data for these two products and produce a structured JSON comparison.

PRODUCT A: ${productA} — offered price ${priceA} ${currency}
PRODUCT B: ${productB} — offered price ${priceB} ${currency}

Return a JSON object with EXACTLY this shape (all text fields must have both "ar" and "en" versions, natural fluent Arabic and English — not machine-translated):

{
  "rows": [
    { "category": {"ar":string,"en":string}, "valueA": {"ar":string,"en":string}, "valueB": {"ar":string,"en":string}, "winner": "A" | "B" | "tie" }
  ],
  "finalRecommendation": { "ar": string, "en": string },
  "resaleValueA": number,
  "resaleValueB": number,
  "resaleValueTimeframe": "1year",
  "warrantyScoreA": number,
  "warrantyScoreB": number
}

Rules:
- Include at least 6 comparison rows covering: price value, build/quality, performance, future compatibility/longevity, resale value potential, warranty/service availability, and overall value for money.
- "winner" must be based on real researched facts about these specific products, never random.
- finalRecommendation must weigh both the researched facts and the two offered prices (${priceA} ${currency} vs ${priceB} ${currency}).
- resaleValueA/B: Estimate what each product will be worth in 1 year (as a percentage of current price, e.g., 65 means 65% of current price). Base this on brand reputation and market demand.
- warrantyScoreA/B: Rate warranty availability and service center accessibility on a scale of 1-10 (10 = excellent warranty + many service centers, 1 = no warranty + hard to find service).
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
    console.warn("[/api/compare] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { productA, productB, priceA, priceB, currency } = req.body || {};

    console.log("[/api/compare] Validating input...");
    if (
      !productA || typeof productA !== "string" ||
      !productB || typeof productB !== "string" ||
      !priceA || Number(priceA) <= 0 ||
      !priceB || Number(priceB) <= 0
    ) {
      console.warn("[/api/compare] Invalid input:", { productA, productB, priceA, priceB });
      return res.status(400).json({ error: "invalid_input" });
    }
    console.log("[/api/compare] Input OK.", { productA, productB, priceA, priceB, currency });

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    // Compare Products is a Premium-only feature (Section 15) — enforce
    // server-side too, never trust the client-side gate alone.
    if (!user) {
      console.warn("[/api/compare] Rejected guest — auth required");
      return res.status(401).json({ error: "auth_required" });
    }

    console.log("[/api/compare] Loading user row...");
    const { data: userRow, error: userErr } = await admin
      .from("users")
      .select("tier, subscription_end_date, compares_used_this_month, compares_reset_at")
      .eq("id", user.id)
      .single();

    if (userErr || !userRow) {
      console.error("[/api/compare] user_not_found. Supabase error:", userErr);
      return res.status(404).json({ error: "user_not_found" });
    }
    console.log("[/api/compare] User row loaded. tier:", userRow.tier, "| comparesUsed:", userRow.compares_used_this_month);

    const now = new Date();
    let tier: "free" | "premium" = userRow.tier;
    if (tier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
      tier = "free";
      await admin.from("users").update({ tier: "free" }).eq("id", user.id);
    }

    if (tier !== "premium") {
      console.warn("[/api/compare] Rejected non-premium user:", user.id);
      return res.status(403).json({ error: "premium_required" });
    }

    // Reset the counter if we've rolled into a new calendar month since the
    // last reset (same logic /api/analyze uses for scans_reset_at).
    const resetAt = new Date(userRow.compares_reset_at);
    const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
    const comparesUsed = needsReset ? 0 : userRow.compares_used_this_month;
    if (needsReset) {
      await admin.from("users").update({ compares_used_this_month: 0, compares_reset_at: now.toISOString() }).eq("id", user.id);
    }

    if (comparesUsed >= COMPARE_MONTHLY_LIMIT) {
      console.warn("[/api/compare] Monthly compare limit reached for user:", user.id);
      return res.status(403).json({ error: "compare_limit_reached", remaining: 0, max: COMPARE_MONTHLY_LIMIT });
    }

    const prompt = buildComparePrompt(productA, productB, Number(priceA), Number(priceB), currency || "EGP");

    let aiResult;
    try {
      logStep("Calling AI pipeline (Groq + Tavily) for comparison...");
      aiResult = await callAiWithFallback(prompt);
      console.log("[/api/compare] AI pipeline succeeded. modelUsed:", aiResult.modelUsed, "| usage:", aiResult.usage);
    } catch (e: any) {
      console.error("[/api/compare] AI pipeline failed (both primary and fallback exhausted):");
      console.error(e);
      console.error(e?.stack);
      return res.status(502).json({ error: "comparison_failed", reason: e?.message });
    }

    const parsed = aiResult.data;
    if (!Array.isArray(parsed?.rows) || !parsed?.finalRecommendation) {
      console.error("[/api/compare] AI response failed shape validation. parsed:", JSON.stringify(parsed)?.slice(0, 2000));
      return res.status(502).json({ error: "comparison_invalid" });
    }

    // Normalize resale values and warranty scores (with safe defaults)
    const resaleValueA = typeof parsed.resaleValueA === "number" && parsed.resaleValueA > 0 ? Math.min(100, Math.max(0, parsed.resaleValueA)) : 50;
    const resaleValueB = typeof parsed.resaleValueB === "number" && parsed.resaleValueB > 0 ? Math.min(100, Math.max(0, parsed.resaleValueB)) : 50;
    const warrantyScoreA = typeof parsed.warrantyScoreA === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreA)) : 5;
    const warrantyScoreB = typeof parsed.warrantyScoreB === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreB)) : 5;

    console.log("Saving database...");
    await logAiUsage(admin, {
      endpoint: "compare",
      model: aiResult.modelUsed,
      tier: "premium",
      userId: user.id,
      usage: aiResult.usage,
    });

    // ---- Record usage AFTER a successful comparison (never before) ----
    const newComparesUsed = comparesUsed + 1;
    await admin.from("users").update({ compares_used_this_month: newComparesUsed }).eq("id", user.id);
    console.log("Saving database... done");

    const result = {
      productA,
      productB,
      priceA: Number(priceA),
      priceB: Number(priceB),
      currency: currency || "EGP",
      rows: parsed.rows,
      finalRecommendation: parsed.finalRecommendation,
      resaleValueA,
      resaleValueB,
      resaleValueTimeframe: "1year",
      warrantyScoreA,
      warrantyScoreB,
      remaining: Math.max(0, COMPARE_MONTHLY_LIMIT - newComparesUsed),
      max: COMPARE_MONTHLY_LIMIT,
    };

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json(result);
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
