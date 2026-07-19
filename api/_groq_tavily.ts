// Shared Groq + Tavily calling logic, replacing Gemini + built-in search
// grounding. Two-stage pipeline per call:
//   1. Tavily runs a live web search for the product (real pricing/pros/cons
//      data) — this replaces Gemini's `google_search` grounding tool.
//   2. Groq (OpenAI-compatible chat-completions API) ingests the raw Tavily
//      results as context and returns the structured JSON analysis.
//
// 2026-07-19 note: the models originally requested — llama3-70b-8192 and
// llama-3.1-70b-versatile / llama-3.3-70b-versatile — are ALL deprecated on
// Groq as of their June 17, 2026 deprecation wave (console.groq.com/docs/deprecations).
// Shipping any of them would just swap one "model stopped working" incident
// (Gemini 429s) for another (Groq 400s on a dead model ID) within weeks.
// Groq's own migration guidance points to openai/gpt-oss-120b as the direct
// replacement for llama-3.3-70b-versatile, so that's the PRIMARY model here,
// with openai/gpt-oss-20b as a second, independent-quota FALLBACK — mirroring
// the primary/fallback pattern that was already working well in _gemini.ts.
// If you specifically want a Llama model, meta-llama/llama-4-maverick or a
// current-generation Llama model from console.groq.com/docs/models will work
// as drop-in replacements for either constant below — just check that page
// before picking one; Groq deprecates fast.
const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

// Kept as `AiUsage` (not `GeminiUsage`) since it's now provider-agnostic.
// _costTracking.ts imports this type — update that import when you copy
// this file in (see instructions below).
export interface AiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueryCount: number; // number of Tavily search calls billed for this request (0 or 1)
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

async function searchTavily(query: string): Promise<{ results: TavilyResult[]; answer: string | null }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY env var");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Tavily's current auth scheme is a Bearer header (older docs show
      // api_key in the JSON body — both still work, but Bearer is what
      // Tavily's own docs lead with now).
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced", // better relevance for pricing/spec research than "basic"
      max_results: 8,
      include_answer: true,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tavily search error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const results: TavilyResult[] = Array.isArray(json?.results)
    ? json.results.map((r: any) => ({ title: r.title || "", url: r.url || "", content: r.content || "" }))
    : [];

  return { results, answer: json?.answer || null };
}

// Pulls a clean search query out of the analyst prompt instead of sending
// the whole multi-hundred-word prompt to Tavily. Handles both the single-
// product shape from analyze.ts/ask.ts ("PRODUCT: ...") and the two-product
// shape from compare.ts ("PRODUCT A: ..." / "PRODUCT B: ...").
function buildSearchQuery(prompt: string): string {
  const productA = prompt.match(/PRODUCT A:\s*(.+)/i);
  const productB = prompt.match(/PRODUCT B:\s*(.+)/i);
  if (productA && productB) {
    return `${productA[1].trim()} vs ${productB[1].trim()} price comparison`;
  }
  const single = prompt.match(/PRODUCT:\s*(.+)/i);
  const product = single ? single[1].trim() : prompt.slice(0, 200);
  return `${product} current market price pros and cons review`;
}

function formatSearchContext(results: TavilyResult[], answer: string | null): string {
  if (results.length === 0) return "No live web search results were available for this query.";
  const items = results
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content.slice(0, 800)}`)
    .join("\n\n");
  return `${answer ? `SEARCH SUMMARY: ${answer}\n\n` : ""}SEARCH RESULTS:\n${items}`;
}

async function callGroqModel(
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ text: string; usage: Omit<AiUsage, "searchQueryCount"> }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY env var");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      // Groq's OpenAI-compatible JSON mode — equivalent to Gemini's
      // responseMimeType: "application/json".
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${model} error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`Groq ${model} returned no text content`);

  return {
    text,
    usage: {
      promptTokens: json?.usage?.prompt_tokens || 0,
      outputTokens: json?.usage?.completion_tokens || 0,
      totalTokens: json?.usage?.total_tokens || 0,
    },
  };
}

function tryParseJson(text: string): any {
  // Strip markdown code fences if the model added them despite instructions
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(" 429") || msg.includes("rate_limit") || msg.includes("quota");
}

// Drop-in replacement for callGeminiWithFallback — same signature, same
// return shape (data / modelUsed / usage / usedSearch), so analyze.ts,
// ask.ts, and compare.ts only need an import-line + function-name change.
export async function callAiWithFallback(
  prompt: string,
  imageBase64?: { data: string; mimeType: string },
  useSearch: boolean = true
): Promise<{ data: any; modelUsed: string; usage: AiUsage; usedSearch: boolean }> {
  if (imageBase64) {
    // Neither gpt-oss-120b nor gpt-oss-20b accept image input on Groq.
    // Gemini's flow supported photo-based analysis (e.g. a screenshot of a
    // listing); that capability has no direct equivalent here. Rather than
    // silently mis-handling it, this logs loudly and proceeds text-only.
    // If image support matters to you, route imageBase64 requests to a
    // vision-capable model instead (check console.groq.com/docs/models for
    // whichever multimodal model is current — Groq's vision lineup changes
    // often) and merge the result the same way this function does.
    console.warn(
      "[GroqTavily] imageBase64 provided but current Groq text models can't read images — proceeding without image analysis."
    );
  }

  let searchContext = "";
  let searchQueryCount = 0;

  if (useSearch) {
    try {
      const query = buildSearchQuery(prompt);
      const { results, answer } = await searchTavily(query);
      searchContext = formatSearchContext(results, answer);
      searchQueryCount = 1; // one billed Tavily search call for this request
    } catch (e) {
      console.error("[GroqTavily] Tavily search failed — proceeding on the model's own knowledge only:", e);
      searchContext =
        "Live web search was unavailable for this request. Use your best general knowledge, and prefer a wider/more conservative price range since this isn't confirmed by live data.";
    }
  }

  const systemPrompt =
    "You are a purchase-decision analyst. Respond with ONLY a single valid JSON object — no markdown formatting, no code fences, no explanatory text before or after it.";

  const userPrompt = useSearch
    ? `${prompt}\n\n---\nLIVE WEB SEARCH CONTEXT (treat this as your primary source for current pricing/market data):\n${searchContext}`
    : prompt;

  // 1. Try primary model
  try {
    const { text, usage } = await callGroqModel(PRIMARY_MODEL, systemPrompt, userPrompt);
    return {
      data: tryParseJson(text),
      modelUsed: PRIMARY_MODEL,
      usage: { ...usage, searchQueryCount },
      usedSearch: useSearch,
    };
  } catch (e1) {
    console.error(`[GroqTavily] Primary model (${PRIMARY_MODEL}) failed:`, e1);
    if (isRateLimitError(e1)) {
      console.error("[GroqTavily] Primary hit its rate limit — going straight to fallback's separate quota.");
    }
  }

  // 2. Fall back to a different model — own quota bucket, silent to the user
  try {
    const strictSuffix = "\n\nCRITICAL: Return ONLY valid JSON. No markdown, no code fences, no text before or after the JSON object.";
    const { text, usage } = await callGroqModel(FALLBACK_MODEL, systemPrompt, userPrompt + strictSuffix);
    return {
      data: tryParseJson(text),
      modelUsed: FALLBACK_MODEL,
      usage: { ...usage, searchQueryCount },
      usedSearch: useSearch,
    };
  } catch (e2) {
    console.error(`[GroqTavily] Fallback model (${FALLBACK_MODEL}) also failed:`, e2);
    throw new Error("ai_unavailable");
  }
}
