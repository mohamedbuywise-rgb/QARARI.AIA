import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callAiWithFallback } from "./_groq_tavily.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";

// Fixed, closed set of categories the frontend already has a matching
// Lucide icon for (see src/lib/categoryIcons.ts). Keeping this list closed
// means the model can never hand back something the UI can't render.
const ICON_CATEGORIES = [
  "phone", "laptop", "watch", "headphones", "camera", "tv",
  "car", "shoes", "bag", "console", "other",
] as const;

// Small in-memory cache (per warm serverless instance) so re-rendering the
// same report or retyping the same product name doesn't re-spend a Groq
// call just to re-derive the same category.
const cache = new Map<string, string>();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { product } = req.body || {};
    if (!product || typeof product !== "string" || !product.trim()) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const key = product.trim().toLowerCase();
    if (cache.has(key)) {
      return res.status(200).json({ category: cache.get(key), cached: true });
    }

    const prompt = `Classify this product name into exactly ONE of these categories: ${ICON_CATEGORIES.join(", ")}.
Product: "${product.trim()}"
Return a JSON object with EXACTLY this shape and nothing else:
{ "category": string }
The "category" value MUST be one of: ${ICON_CATEGORIES.join(", ")}. If unsure, use "other".`;

    // useSearch=false: this is a plain classification call, no Tavily/Serper
    // lookup and no interaction with the pricing pipeline whatsoever.
    const aiResult = await callAiWithFallback(prompt, undefined, false);
    let category = aiResult?.data?.category;
    if (typeof category !== "string" || !ICON_CATEGORIES.includes(category as any)) {
      category = "other";
    }

    cache.set(key, category);
    logRequestSuccess(start);
    return res.status(200).json({ category });
  } catch (err: any) {
    logUnhandledError(err, start);
    // Never fail the page over a cosmetic icon — the frontend already has a
    // local keyword-based fallback icon it can keep showing.
    return res.status(200).json({ category: "other", error: err?.message });
  }
}
