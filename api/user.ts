import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback, classifyProductCategory } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";
import { DEFAULT_PREMIUM_LIMITS, getAllPlans } from "./_planConfig.js";
import { sendTelegramAlert } from "./_telegram.js";

// ---------------------------------------------------------------------------
// Consolidated user-facing API — merges what used to be 3 separate
// serverless functions (scans-remaining, compare, subscribe) plus the new
// smart-icon classification call into a single Vercel Function, dispatched
// by `?action=` (query string). Keeps the project well under the Hobby
// plan's 12-function limit while preserving each route's exact original
// behavior, request/response shape, and auth checks.
//
// Frontend calls now look like:
//   /api/user?action=scans-remaining  (was /api/scans-remaining)
//   /api/user?action=compare          (was /api/compare)
//   /api/user?action=subscribe        (was /api/subscribe)
//   /api/user?action=classify-icon    (new — smart product icon)
// ---------------------------------------------------------------------------

const FREE_MONTHLY_LIMIT = 50; // temporarily raised from 5 for testing
const PREMIUM_MONTHLY_LIMIT = 50; // fair-use cap for paid subscribers, prevents runaway AI cost from outlier usage
const DEFAULT_COMPARE_LIMIT = DEFAULT_PREMIUM_LIMITS.compares;

const PLAN_PRICES: Record<string, number> = {};
for (const plan of getAllPlans()) {
  PLAN_PRICES[plan.id] = plan.price;
}

async function handleScansRemaining(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);
  const now = new Date();

  if (user) {
    console.log("[/api/user?action=scans-remaining] Loading user row:", user.id);
    const { data: row } = await admin
      .from("users")
      .select("tier, scans_used_this_month, scans_reset_at")
      .eq("id", user.id)
      .single();

    if (!row) {
      console.error("[/api/user?action=scans-remaining] user_not_found:", user.id);
      return res.status(404).json({ error: "user_not_found" });
    }

    const resetAt = new Date(row.scans_reset_at);
    const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
    const used = needsReset ? 0 : row.scans_used_this_month;

    if (row.tier === "premium") {
      const remaining = Math.max(0, PREMIUM_MONTHLY_LIMIT - used);
      return res.status(200).json({ unlimited: false, remaining, max: PREMIUM_MONTHLY_LIMIT });
    }

    const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used);
    return res.status(200).json({ unlimited: false, remaining, max: FREE_MONTHLY_LIMIT });
  } else {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    console.log("[/api/user?action=scans-remaining] Guest request. IP:", ip);
    const { data: row } = await admin.from("guest_usage").select("*").eq("ip_address", ip).single();

    let used = 0;
    if (row) {
      const resetAt = new Date(row.scans_reset_at);
      const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
      used = needsReset ? 0 : row.scans_used_this_month;
    }
    const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used);
    return res.status(200).json({ unlimited: false, remaining, max: FREE_MONTHLY_LIMIT });
  }
}

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

async function handleCompare(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  logEnvPresence({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  const { productA, productB, priceA, priceB, currency } = req.body || {};

  if (
    !productA || typeof productA !== "string" ||
    !productB || typeof productB !== "string" ||
    !priceA || Number(priceA) <= 0 ||
    !priceB || Number(priceB) <= 0
  ) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);

  // Compare Products is a Premium-only feature (Section 15) — enforce
  // server-side too, never trust the client-side gate alone.
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const { data: userRow, error: userErr } = await admin
    .from("users")
    .select("tier, subscription_end_date, compares_used_this_month, compares_reset_at, compares_limit_this_month")
    .eq("id", user.id)
    .single();

  if (userErr || !userRow) {
    return res.status(404).json({ error: "user_not_found" });
  }

  const now = new Date();
  let tier: "free" | "premium" = userRow.tier;
  if (tier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
    tier = "free";
    await admin.from("users").update({ tier: "free" }).eq("id", user.id);
  }

  if (tier !== "premium") {
    return res.status(403).json({ error: "premium_required" });
  }

  const resetAt = new Date(userRow.compares_reset_at);
  const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
  const comparesUsed = needsReset ? 0 : userRow.compares_used_this_month;
  if (needsReset) {
    await admin.from("users").update({ compares_used_this_month: 0, compares_reset_at: now.toISOString() }).eq("id", user.id);
  }

  // Section 15: Use dynamic limit from user row (stored when plan was activated)
  const comparesLimit = userRow.compares_limit_this_month || DEFAULT_COMPARE_LIMIT;

  if (comparesUsed >= comparesLimit) {
    return res.status(403).json({ error: "compare_limit_reached", remaining: 0, max: comparesLimit });
  }

  const prompt = buildComparePrompt(productA, productB, Number(priceA), Number(priceB), currency || "EGP");

  let aiResult;
  try {
    logStep("Calling AI pipeline (Groq + Tavily) for comparison...");
    aiResult = await callAiWithFallback(prompt);
  } catch (e: any) {
    console.error("[/api/user?action=compare] AI pipeline failed (both primary and fallback exhausted):", e, e?.stack);
    return res.status(502).json({ error: "comparison_failed", reason: e?.message });
  }

  const parsed = aiResult.data;
  if (!Array.isArray(parsed?.rows) || !parsed?.finalRecommendation) {
    console.error("[/api/user?action=compare] AI response failed shape validation. parsed:", JSON.stringify(parsed)?.slice(0, 2000));
    return res.status(502).json({ error: "comparison_invalid" });
  }

  const resaleValueA = typeof parsed.resaleValueA === "number" && parsed.resaleValueA > 0 ? Math.min(100, Math.max(0, parsed.resaleValueA)) : 50;
  const resaleValueB = typeof parsed.resaleValueB === "number" && parsed.resaleValueB > 0 ? Math.min(100, Math.max(0, parsed.resaleValueB)) : 50;
  const warrantyScoreA = typeof parsed.warrantyScoreA === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreA)) : 5;
  const warrantyScoreB = typeof parsed.warrantyScoreB === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreB)) : 5;

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
    // Bug fix: this previously referenced an undefined `COMPARE_MONTHLY_LIMIT`
    // (a leftover name from before the dynamic per-plan limit was added),
    // which would have thrown a ReferenceError on every successful compare.
    // The correct value is the per-user dynamic `comparesLimit` computed above.
    remaining: Math.max(0, comparesLimit - newComparesUsed),
    max: comparesLimit,
  };

  return res.status(200).json(result);
}

async function handleSubscribe(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const user = await getAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const { plan, screenshotUrl } = req.body || {};
  const amount = PLAN_PRICES[plan];

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "invalid_plan" });
  }
  if (!screenshotUrl || typeof screenshotUrl !== "string") {
    return res.status(400).json({ error: "missing_screenshot" });
  }

  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("subscription_requests")
    .insert({
      user_id: user.id,
      plan,
      amount,
      screenshot_url: screenshotUrl,
      status: "pending_review",
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[/api/user?action=subscribe] insert failed:", error);
    return res.status(500).json({ error: "server_error" });
  }

  await sendTelegramAlert(
    `💰 <b>New subscription request</b>\nUser: ${user.email}\nPlan: ${plan}\nAmount: ${amount} EGP\nScreenshot: ${screenshotUrl}`
  );

  return res.status(200).json({ success: true, requestId: data.id });
}

async function handleClassifyIcon(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { productName } = req.body || {};
  if (!productName || typeof productName !== "string") {
    return res.status(400).json({ error: "invalid_input", category: "other" });
  }

  try {
    const category = await classifyProductCategory(productName);
    return res.status(200).json({ category });
  } catch (e: any) {
    // Never let this block the UI — always resolve with a safe fallback.
    console.error("[/api/user?action=classify-icon] failed, returning fallback:", e);
    return res.status(200).json({ category: "other" });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  const action = (req.query?.action as string) || (req.method === "POST" ? (req.body || {}).action : undefined);

  try {
    let result: VercelResponse | void;
    switch (action) {
      case "scans-remaining":
        result = await handleScansRemaining(req, res);
        break;
      case "compare":
        result = await handleCompare(req, res);
        break;
      case "subscribe":
        result = await handleSubscribe(req, res);
        break;
      case "classify-icon":
        result = await handleClassifyIcon(req, res);
        break;
      default:
        return res.status(400).json({ error: "unknown_action" });
    }

    logRequestSuccess(start);
    return result;
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
