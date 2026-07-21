import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";

// Hard cap on how many chat questions can be asked per analysis. Each
// question is a Groq call WITHOUT a Tavily search (unlike the main
// analysis) — plain reasoning over the existing report context only —
// so the per-message cost is low enough to allow a much higher cap.
const MAX_CHAT_MESSAGES_PER_REPORT = 20;

// Open shopping advisor mode (no report context required) — allows unlimited
// free-form shopping questions. Premium users get unlimited queries; free users
// are capped per month.
const MAX_ADVISOR_MESSAGES_PER_MONTH_FREE = 300;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface UserInterests {
  categories: string[];
  recentSearches: string[];
  favoriteProducts: string[];
}

function buildAdvisorPrompt(opts: {
  question: string;
  history: ChatTurn[];
  language: "ar" | "en";
  userInterests?: UserInterests;
}) {
  const { question, history, language, userInterests } = opts;
  const languageInstruction = language === "ar" ? "أجب بالعربية الطبيعية الودية." : "Answer in natural, friendly English.";

  let interestContext = "";
  if (userInterests?.categories?.length) {
    interestContext = `\nYour shopping interests: ${userInterests.categories.join(", ")}\nRecent searches: ${userInterests.recentSearches.join(", ")}`;
  }

  const historyBlock = history.map((m) => `${m.role === "user" ? "You" : "Me"}: ${m.content}`).join("\n");

  return `You are a friendly, expert shopping advisor (like a personal shopping consultant). Help users make smart purchase decisions by:
1. Understanding their budget and needs
2. Suggesting real products with realistic prices
3. Comparing options fairly
4. Proactively warning about common pitfalls
5. Remembering their past interests

IMPORTANT: Always be proactive. After answering the user's question, proactively add one helpful suggestion at the end using these patterns:
- If they ask about a specific model: "الموديل اللي بتسأل عليه ده نزل منه نسخة أحدث، تحب أقارنلك؟" or "This model has a newer version available, want me to compare?"
- If they mention a price: "في نفس النطاق ده فيه خيارات تانية ممكن تكون أفضل، تحب أقولك؟"
- If they compare products: mention pros/cons and battery life or common issues proactively

${interestContext}

CONVERSATION HISTORY:
${historyBlock || "(New conversation)"}

USER'S QUESTION: ${question}

${languageInstruction} Be conversational, warm, and helpful. Keep answers to 3-5 sentences. If you suggest products, mention realistic price ranges. Always end with a helpful proactive tip or suggestion.`;
}

function buildChatPrompt(opts: {
  product: string;
  offeredPrice: number;
  currency: string;
  verdict: string;
  marketFairPriceMin: number;
  marketFairPriceMax: number;
  history: ChatTurn[];
  question: string;
  language: "ar" | "en";
}) {
  const { product, offeredPrice, currency, verdict, marketFairPriceMin, marketFairPriceMax, history, question, language } = opts;

  // Cost-saving: send only the base product context + the single last
  // assistant reply, not the full conversation history. The model doesn't
  // need every prior turn to answer a short follow-up — just the last thing
  // it said (for continuity) plus the fixed analysis context above.
  const lastAssistantTurn = [...history].reverse().find((m) => m.role === "assistant");
  const historyBlock = lastAssistantTurn ? `Assistant: ${lastAssistantTurn.content}` : "";

  const languageInstruction = language === "ar" ? "Answer in natural, fluent Arabic (Egyptian-friendly)." : "Answer in natural, fluent English.";

  return `You are a helpful purchase-decision assistant answering a short follow-up question about an analysis the user already received. Base your answer on the analysis context and conversation below only — you do not have live web/search access for this chat, so don't claim to look anything up; answer from the given facts and general knowledge.

ANALYSIS CONTEXT:
- Product: ${product}
- Offered price: ${offeredPrice} ${currency}
- Verdict: ${verdict}
- Fair market range: ${marketFairPriceMin}-${marketFairPriceMax} ${currency}

${historyBlock ? `LAST REPLY:\n${historyBlock}\n` : ""}
NEW QUESTION: ${question}

${languageInstruction} Keep the answer short and conversational — 2-4 sentences, no headers or markdown.

Return a JSON object with EXACTLY this shape and nothing else:
{ "answer": string }`;
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
    console.warn("[/api/ask] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const {
      reportId,
      product,
      offeredPrice,
      currency,
      verdict,
      marketFairPriceMin,
      marketFairPriceMax,
      question,
      history = [],
      language = "ar",
      mode = "report", // "report" for analysis chat, "advisor" for open shopping questions
    } = req.body || {};

    console.log("[/api/ask] Validating input...");
    if (!question || typeof question !== "string" || !question.trim()) {
      console.warn("[/api/ask] Invalid input (question):", { question });
      return res.status(400).json({ error: "invalid_input" });
    }

    // Mode validation: "report" requires reportId, "advisor" is open-form
    if (mode === "report") {
      if (!reportId || typeof reportId !== "string") {
        console.warn("[/api/ask] Invalid input (reportId required for report mode):", { reportId });
        return res.status(400).json({ error: "invalid_input" });
      }
      if (!product || typeof product !== "string" || typeof offeredPrice !== "number") {
        console.warn("[/api/ask] Invalid input (product/offeredPrice):", { product, offeredPrice });
        return res.status(400).json({ error: "invalid_input" });
      }
    }
    console.log("[/api/ask] Input OK. mode:", mode, "| question:", question.slice(0, 50));

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    // Advisor mode with smart memory requires login to save interests
    if (mode === "advisor" && !user) {
      console.warn("[/api/ask] Advisor mode requires authentication for smart memory features");
      return res.status(401).json({ error: "auth_required_for_advisor", message: "Please sign in to use smart memory features" });
    }

    const identity = user
      ? `user:${user.id}`
      : `ip:${(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown"}`;

    let used = 0;

    if (mode === "advisor") {
      // Open advisor mode: track monthly usage per user/IP
      console.log("[/api/ask] Loading advisor usage for identity:", identity);
      const { data: advisorUsageRow } = await admin
        .from("advisor_usage")
        .select("messages_used, reset_at")
        .eq("identity", identity)
        .single();

      // Check if we need to reset the monthly counter
      const now = new Date();
      const resetAt = advisorUsageRow?.reset_at ? new Date(advisorUsageRow.reset_at) : null;
      const needsReset = !resetAt || now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();

      if (needsReset) {
        used = 0;
        await admin.from("advisor_usage").upsert({
          identity,
          messages_used: 0,
          reset_at: now.toISOString(),
        });
      } else {
        used = advisorUsageRow?.messages_used || 0;
      }
      console.log("[/api/ask] Advisor usage loaded. used:", used);
    } else {
      // Report mode: track per-report usage
      console.log("[/api/ask] Loading chat usage for identity:", identity);
      const { data: usageRow } = await admin
        .from("chat_usage")
        .select("messages_used")
        .eq("report_id", reportId)
        .eq("identity", identity)
        .single();

      used = usageRow?.messages_used || 0;
      console.log("[/api/ask] Chat usage loaded. used:", used);
    }

    // Real tier — also determines whether the chat cap applies.
    // Premium subscribers get unlimited chat; Free/guest users stay capped for cost control.
    let tier: "free" | "premium" | "guest" = "guest";
    if (user) {
      const { data: userRow } = await admin
        .from("users")
        .select("tier, subscription_end_date")
        .eq("id", user.id)
        .single();
      let effectiveTier = userRow?.tier || "free";
      if (effectiveTier === "premium" && userRow?.subscription_end_date && new Date(userRow.subscription_end_date) < new Date()) {
        effectiveTier = "free";
        await admin.from("users").update({ tier: "free" }).eq("id", user.id);
      }
      tier = effectiveTier as "free" | "premium";
    }

    const isUnlimitedChat = tier === "premium";
    const maxMessages = mode === "advisor" ? MAX_ADVISOR_MESSAGES_PER_MONTH_FREE : MAX_CHAT_MESSAGES_PER_REPORT;

    if (!isUnlimitedChat && used >= maxMessages) {
      console.warn("[/api/ask] Chat message limit reached. identity:", identity, "| used:", used, "| mode:", mode);
      return res.status(403).json({ error: "chat_limit_reached", remaining: 0, max: maxMessages });
    }

    let prompt: string;

    if (mode === "advisor") {
      // Fetch user interests if available
      let userInterests: UserInterests | undefined;
      if (user) {
        const { data: interestsRow } = await admin
          .from("user_interests")
          .select("categories, recent_searches, favorite_products")
          .eq("user_id", user.id)
          .single();
        if (interestsRow) {
          userInterests = {
            categories: interestsRow.categories || [],
            recentSearches: interestsRow.recent_searches || [],
            favoriteProducts: interestsRow.favorite_products || [],
          };
        }
      }

      prompt = buildAdvisorPrompt({
        question: question.trim(),
        history: Array.isArray(history) ? history : [],
        language: language === "en" ? "en" : "ar",
        userInterests,
      });
    } else {
      // Report mode: use existing chat prompt
      prompt = buildChatPrompt({
        product,
        offeredPrice: Number(offeredPrice),
        currency: currency || "EGP",
        verdict: verdict || "fair",
        marketFairPriceMin: Number(marketFairPriceMin) || 0,
        marketFairPriceMax: Number(marketFairPriceMax) || 0,
        history: Array.isArray(history) ? history : [],
        question: question.trim(),
        language: language === "en" ? "en" : "ar",
      });
    }

    let aiResult;
    try {
      logStep("Calling AI pipeline (Groq, no search) for chat answer...");
      aiResult = await callAiWithFallback(prompt, undefined, false);
      console.log("[/api/ask] AI pipeline succeeded. modelUsed:", aiResult.modelUsed, "| usage:", aiResult.usage);
    } catch (e: any) {
      console.error("[/api/ask] AI pipeline failed (both primary and fallback exhausted):");
      console.error(e);
      console.error(e?.stack);
      return res.status(502).json({ error: "ask_failed", reason: e?.message });
    }

    const answer = aiResult.data?.answer;
    if (typeof answer !== "string" || !answer.trim()) {
      console.error("[/api/ask] AI response failed shape validation. data:", JSON.stringify(aiResult.data)?.slice(0, 2000));
      return res.status(502).json({ error: "ask_invalid" });
    }

    // Section 25: log every real Groq call, same as /api/analyze and /api/compare.
    console.log("Saving database...");
    await logAiUsage(admin, {
      endpoint: "ask",
      model: aiResult.modelUsed,
      tier,
      userId: user?.id || null,
      usage: aiResult.usage,
    });

    // ---- Record usage AFTER a successful answer (never before) ----
    const newUsed = used + 1;
    if (mode === "advisor") {
      await admin.from("advisor_usage").upsert({
        identity,
        messages_used: newUsed,
        reset_at: new Date().toISOString(),
      });

      // Smart Memory System: update user interests after each advisor interaction
      if (user) {
        try {
          // Extract product mentions from the user's question for smart memory
          const questionLower = question.toLowerCase();
          const productKeywords = [
            "موبايل", "iphone", "samsung", "xiaomi", "هاتف", "mobile", "phone",
            "لابتوب", "laptop", "كمبيوتر", "computer", "macbook",
            "سماعات", "headphone", "airpods", "earbuds",
            "تلفزيون", "tv", "شاشة", "monitor",
            "كاميرا", "camera",
            "ساعة", "watch", "apple watch",
            "تابلت", "tablet", "ipad",
            "جهاز", "device",
          ];
          const detectedCategories = productKeywords.filter((kw) =>
            questionLower.includes(kw)
          );

          if (detectedCategories.length > 0) {
            const { data: existingInterests } = await admin
              .from("user_interests")
              .select("categories, recent_searches")
              .eq("user_id", user.id)
              .single();

            if (existingInterests) {
              // Merge new categories with existing ones
              const existingCats = existingInterests.categories || [];
              const newCats = [...new Set([...existingCats, ...detectedCategories])];

              // Add to recent searches
              const existingSearches = existingInterests.recent_searches || [];
              const newSearches = [question.slice(0, 100), ...existingSearches].slice(0, 20);

              await admin
                .from("user_interests")
                .update({
                  categories: newCats,
                  recent_searches: newSearches,
                  updated_at: new Date().toISOString(),
                })
                .eq("user_id", user.id);
            } else {
              // Create new interests record
              await admin.from("user_interests").upsert({
                user_id: user.id,
                categories: detectedCategories,
                recent_searches: [question.slice(0, 100)],
                favorite_products: [],
                updated_at: new Date().toISOString(),
              });
            }
          }
        } catch (memoryErr) {
          console.warn("[advisor] Smart memory update failed (non-critical):", memoryErr);
        }
      }
    } else {
      await admin.from("chat_usage").upsert({
        report_id: reportId,
        identity,
        messages_used: newUsed,
        updated_at: new Date().toISOString(),
      });
    }
    console.log("Saving database... done");

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({
      answer: answer.trim(),
      remaining: isUnlimitedChat ? null : Math.max(0, maxMessages - newUsed),
      max: isUnlimitedChat ? null : maxMessages,
      unlimited: isUnlimitedChat,
      mode,
    });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
