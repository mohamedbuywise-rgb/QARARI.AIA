import { logStep, logEnvPresence, loggedFetch, loggedJsonParse } from "./_logger.js";
import { computeMarketPriceRange, formatMarketPriceContext, isSupportedCurrency } from "./_priceExtraction.js";

// Shared Groq + Tavily + Serper calling logic, replacing Gemini + built-in
// search grounding. Three-way split per call:
//   1. Tavily runs a live web search for the product (specs/pros/cons/
//      review context) — this replaces Gemini's `google_search` grounding
//      tool.
//   2. Serper (Google SERP API) runs a separate, price-only search for
//      whichever product has a target currency in the prompt — this is the
//      live price source that feeds computeMarketPriceRange() in
//      _priceExtraction.ts. If Serper is unavailable (missing key, outage),
//      price extraction falls back to mining the Tavily results instead, so
//      pricing keeps working either way.
//   3. Groq (OpenAI-compatible chat-completions API) ingests the Tavily
//      specs context + the Serper-derived price range as context and
//      returns the structured JSON analysis.
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
  rawContent: string | null;
}

async function searchTavily(
  query: string,
  opts: { includeDomains?: string[] } = {}
): Promise<{ results: TavilyResult[]; answer: string | null }> {
  console.log("Calling Tavily...");
  console.log("[Tavily] Query:", query);
  if (opts.includeDomains?.length) {
    console.log("[Tavily] Domain restriction:", opts.includeDomains.join(", "));
  }

  const apiKey = process.env.TAVILY_API_KEY;
  logEnvPresence({ TAVILY_API_KEY: apiKey });
  if (!apiKey) {
    console.error("[Tavily] Missing TAVILY_API_KEY env var");
    throw new Error("Missing TAVILY_API_KEY env var");
  }

  let res: Response;
  try {
    res = await loggedFetch("tavily.search", "https://api.tavily.com/search", {
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
        // `content` alone is Tavily's own curated/trimmed excerpt of the
        // page and can end up cut off before the actual price appears
        // (especially on regional Arabic e-commerce pages, where the price
        // often sits further down than whatever Tavily judged "the most
        // relevant chunk"). Requesting raw_content too gives the price
        // extractor in _priceExtraction.ts a full scrape of the page to
        // scan, at no extra Tavily search-call cost (still one billed
        // search) — it only adds more text to the same response.
        include_raw_content: true,
        ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
      }),
    });
  } catch (error: any) {
    console.error("TAVILY ERROR");
    console.error(error);
    console.error(error?.stack);
    throw error;
  }

  console.log("Status:", res.status);

  if (!res.ok) {
    const errText = await res.text();
    console.error("[Tavily] Non-OK response body:", errText);
    throw new Error(`Tavily search error ${res.status}: ${errText}`);
  }

  const bodyText = await res.text();
  console.log("Body:", bodyText.slice(0, 2000));

  const json = loggedJsonParse("tavily.search", bodyText);
  const results: TavilyResult[] = Array.isArray(json?.results)
    ? json.results.map((r: any) => ({
        title: r.title || "",
        url: r.url || "",
        content: r.content || "",
        rawContent: typeof r.raw_content === "string" ? r.raw_content : null,
      }))
    : [];

  console.log("[Tavily] Results count:", results.length);
  console.log("Calling Tavily... done");

  return { results, answer: json?.answer || null };
}

// ---- Alternative provider: Serper.dev (Google Search API) ----------------
// Drop-in alternative to searchTavily() above — same input shape, same
// return shape ({ results: TavilyResult[]; answer: string | null }) — so it
// can be swapped in for searchTavily() at the call sites in
// callAiWithFallback() with a one-line change, whenever that switch is
// wanted. NOT wired into the pipeline yet: nothing below calls this
// function, and _priceExtraction.ts / the rest of the pipeline only ever
// consumes the TavilyResult[] shape, not which provider produced it, so
// nothing else needs to change when it is wired in.
//
// Serper.dev has no native "raw_content" (full page scrape) or "answer"
// (AI-generated summary) concept the way Tavily does — it's a Google SERP
// API. This maps what it does return onto the same shape:
//   - content  -> Serper's `snippet` (the Google result snippet)
//   - rawContent -> always null (Serper doesn't fetch/scrape the page)
//   - answer   -> Serper's `answerBox.answer` / `answerBox.snippet` if
//                 Google shows a featured answer box for the query, else null
// Because rawContent is always null here, computeMarketPriceRange() in
// _priceExtraction.ts will have less text to scan per result than it does
// with Tavily (which does include a raw scrape). That's a real quality
// tradeoff to know about before switching providers, not a bug in this
// function.
async function searchSerper(
  query: string,
  opts: { includeDomains?: string[]; gl?: string; hl?: string } = {}
): Promise<{ results: TavilyResult[]; answer: string | null }> {
  console.log("Calling Serper...");
  console.log("[Serper] Query:", query);
  if (opts.includeDomains?.length) {
    console.log("[Serper] Domain restriction:", opts.includeDomains.join(", "));
  }
  if (opts.gl || opts.hl) {
    console.log("[Serper] Region override — gl:", opts.gl || "(account default)", "hl:", opts.hl || "(account default)");
  }

  const apiKey = process.env.SERPER_API_KEY;
  logEnvPresence({ SERPER_API_KEY: apiKey });
  if (!apiKey) {
    console.error("[Serper] Missing SERPER_API_KEY env var");
    throw new Error("Missing SERPER_API_KEY env var");
  }

  // Serper has no include_domains param — fold domain restriction into the
  // query itself using Google's own "(site:a OR site:b)" syntax instead,
  // same effect as Tavily's include_domains.
  const q = opts.includeDomains?.length
    ? `${query} (${opts.includeDomains.map((d) => `site:${d}`).join(" OR ")})`
    : query;

  let res: Response;
  try {
    res = await loggedFetch("serper.search", "https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Serper's auth header is X-API-KEY, not Bearer.
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({
        q,
        num: 10,
        // gl/hl (Google country/language) are OMITTED when not explicitly
        // passed in, so the call falls back to whatever default is set in
        // the Serper.dev dashboard (e.g. Egypt / Arabic). They're only set
        // here explicitly for currencies whose regional hint below points
        // somewhere else (US, UK, EU, ...) — that override matters because
        // the dashboard default applies to EVERY call otherwise, including
        // ones searching for a non-Egyptian price in English, where an
        // Egypt-biased gl can skew Google's ranking away from the
        // US/UK/EU retailers the query is actually trying to reach.
        ...(opts.gl ? { gl: opts.gl } : {}),
        ...(opts.hl ? { hl: opts.hl } : {}),
      }),
    });
  } catch (error: any) {
    console.error("SERPER ERROR");
    console.error(error);
    console.error(error?.stack);
    throw error;
  }

  console.log("Status:", res.status);

  if (!res.ok) {
    const errText = await res.text();
    console.error("[Serper] Non-OK response body:", errText);
    throw new Error(`Serper search error ${res.status}: ${errText}`);
  }

  const bodyText = await res.text();
  console.log("Body:", bodyText.slice(0, 2000));

  const json = loggedJsonParse("serper.search", bodyText);
  const organic = Array.isArray(json?.organic) ? json.organic : [];
  const results: TavilyResult[] = organic.map((r: any) => ({
    title: r.title || "",
    url: r.link || "",
    content: r.snippet || "",
    rawContent: null, // Serper doesn't provide a full-page scrape
  }));

  const answer: string | null =
    json?.answerBox?.answer || json?.answerBox?.snippet || null;

  console.log("[Serper] Results count:", results.length);
  console.log("Calling Serper... done");

  return { results, answer };
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
  const conditionMatch = prompt.match(/PRODUCT CONDITION:\s*(.+)/i);
  const condition = conditionMatch ? conditionMatch[1].trim() : "";
  
  let conditionQuery = "";
  if (condition === "new") conditionQuery = "brand new sealed";
  else if (condition === "likeNew") conditionQuery = "like new open box كسر زيرو";
  else if (condition === "used") conditionQuery = "used مستعمل";

  return `${product} ${conditionQuery} current market price pros and cons review`.trim().replace(/\s+/g, " ");
}

// Pulls the user's requested currency out of the single-product analyze.ts
// prompt shape ("OFFERED PRICE: 5000 EGP"). Deliberately narrow: only fires
// for that exact shape, so compare.ts's two-product prompt (which has no
// marketFairPrice fields to fill in) and ask.ts (which never reaches this
// function with useSearch=true) are completely unaffected.
function extractTargetCurrency(prompt: string): string | null {
  const match = prompt.match(/OFFERED PRICE:\s*[\d.,\s]+\s*([A-Za-z]{3})\b/);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return isSupportedCurrency(code) ? code : null;
}

// Builds a price-only query for Serper. Kept deliberately separate from
// buildSearchQuery() above (which is tuned for Tavily's specs/pros/cons
// research and includes "review" in the query) — Serper's one job in this
// pipeline is finding the current live price, so the query stays narrow.
function buildPriceSearchQuery(prompt: string, currency: string): string {
  const single = prompt.match(/PRODUCT:\s*(.+)/i);
  const product = single ? single[1].trim() : prompt.slice(0, 200);
  const conditionMatch = prompt.match(/PRODUCT CONDITION:\s*(.+)/i);
  const condition = conditionMatch ? conditionMatch[1].trim() : "";

  let conditionQuery = "";
  if (condition === "new") conditionQuery = "brand new sealed جديد";
  else if (condition === "likeNew") conditionQuery = "like new open box كسر زيرو";
  else if (condition === "used") conditionQuery = "used مستعمل";

  return `${product} ${conditionQuery} price ${currency}`.trim().replace(/\s+/g, " ");
}

// ---- Regional retry: domain restriction + localized query per currency ---
// The generic English query ("iPhone 15 Pro Max current market price...")
// tends to surface global/US-centric pages, which either have no price in
// the user's currency at all, or bury it under unrelated noise — exactly
// the kind of page where the price extractor in _priceExtraction.ts ends
// up with nothing usable. When that happens, callAiWithFallback below
// retries ONCE with a query and domain list targeted at that currency's
// actual regional retailers, in the local language where that's Arabic.
// This list intentionally overlaps with (but is independently maintained
// from) the source-trust weighting list in _priceExtraction.ts — that list
// governs how much a price is trusted once found, this one governs where
// we look in the first place.
interface CurrencyRegionHint {
  countryQueryHint: string; // appended to the query so Tavily biases toward this market
  domains: string[]; // passed as Tavily's include_domains on retry
  arabicPriceWord: string | null; // non-null => also try an Arabic-language query form
  gl: string; // Google/Serper country code for this currency's market
  hl: string; // Google/Serper language code for this currency's market
}

const CURRENCY_REGION_HINTS: Partial<Record<string, CurrencyRegionHint>> = {
  EGP: {
    countryQueryHint: "Egypt",
    domains: [
      "noon.com",
      "amazon.eg",
      "2b.com.eg",
      "btech.com",
      "jumia.com.eg",
      "carrefouregypt.com",
      "raya.com",
    ],
    arabicPriceWord: "سعر في مصر بالجنيه المصري",
    gl: "eg",
    hl: "ar",
  },
  SAR: {
    countryQueryHint: "Saudi Arabia",
    domains: ["noon.com", "amazon.sa", "jarir.com", "extra.com"],
    arabicPriceWord: "سعر في السعودية بالريال السعودي",
    gl: "sa",
    hl: "ar",
  },
  AED: {
    countryQueryHint: "UAE",
    domains: ["noon.com", "amazon.ae", "sharafdg.com"],
    arabicPriceWord: "سعر في الإمارات بالدرهم",
    gl: "ae",
    hl: "ar",
  },
  KWD: {
    countryQueryHint: "Kuwait",
    domains: ["noon.com", "xcite.com"],
    arabicPriceWord: "سعر في الكويت بالدينار الكويتي",
    gl: "kw",
    hl: "ar",
  },
  QAR: {
    countryQueryHint: "Qatar",
    domains: ["noon.com"],
    arabicPriceWord: "سعر في قطر بالريال القطري",
    gl: "qa",
    hl: "ar",
  },
  BHD: {
    countryQueryHint: "Bahrain",
    domains: ["noon.com"],
    arabicPriceWord: "سعر في البحرين بالدينار البحريني",
    gl: "bh",
    hl: "ar",
  },
  OMR: {
    countryQueryHint: "Oman",
    domains: ["noon.com"],
    arabicPriceWord: "سعر في عمان بالريال العماني",
    gl: "om",
    hl: "ar",
  },
  JOD: {
    countryQueryHint: "Jordan",
    domains: ["noon.com"],
    arabicPriceWord: "سعر في الأردن بالدينار الأردني",
    gl: "jo",
    hl: "ar",
  },
  USD: {
    countryQueryHint: "USA",
    domains: ["amazon.com", "bestbuy.com", "bhphotovideo.com", "apple.com"],
    arabicPriceWord: null,
    gl: "us",
    hl: "en",
  },
  GBP: {
    countryQueryHint: "UK",
    domains: ["amazon.co.uk", "currys.co.uk", "argos.co.uk"],
    arabicPriceWord: null,
    gl: "gb",
    hl: "en",
  },
  EUR: {
    countryQueryHint: "Europe",
    domains: ["amazon.de", "amazon.fr", "mediamarkt.de"],
    arabicPriceWord: null,
    gl: "de",
    hl: "en",
  },
};

// Builds the retry query + domain list for a given prompt/currency. Reuses
// the same product-name parsing as buildSearchQuery so both queries are
// anchored to the same product.
function buildLocalizedRetryQuery(
  prompt: string,
  currency: string
): { query: string; domains: string[]; gl: string; hl: string } | null {
  const hint = CURRENCY_REGION_HINTS[currency];
  if (!hint) return null;
  const single = prompt.match(/PRODUCT:\s*(.+)/i);
  const product = single ? single[1].trim() : prompt.slice(0, 200);
  const query = hint.arabicPriceWord
    ? `${product} ${hint.arabicPriceWord}`
    : `${product} price ${hint.countryQueryHint} ${currency}`;
  return { query, domains: hint.domains, gl: hint.gl, hl: hint.hl };
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
  console.log(`Calling Groq (${model})...`);

  const apiKey = process.env.GROQ_API_KEY;
  logEnvPresence({ GROQ_API_KEY: apiKey });
  if (!apiKey) {
    console.error("[Groq] Missing GROQ_API_KEY env var");
    throw new Error("Missing GROQ_API_KEY env var");
  }

  let res: Response;
  try {
    res = await loggedFetch(`groq.${model}`, "https://api.groq.com/openai/v1/chat/completions", {
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
  } catch (error: any) {
    console.error(`GROQ ERROR (${model})`);
    console.error(error);
    console.error(error?.stack);
    throw error;
  }

  console.log("Status:", res.status);

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Groq] Non-OK response body (${model}):`, errText);
    throw new Error(`Groq ${model} error ${res.status}: ${errText}`);
  }

  const bodyText = await res.text();
  const json = loggedJsonParse(`groq.${model}.envelope`, bodyText);
  const text = json?.choices?.[0]?.message?.content;
  if (!text) {
    console.error(`[Groq] ${model} returned no text content. Full response:`, bodyText.slice(0, 2000));
    throw new Error(`Groq ${model} returned no text content`);
  }

  console.log(`[Groq] ${model} raw content:`, text.slice(0, 2000));
  console.log(
    `[Groq] ${model} tokens — prompt: ${json?.usage?.prompt_tokens}, completion: ${json?.usage?.completion_tokens}, total: ${json?.usage?.total_tokens}`
  );
  console.log(`Calling Groq (${model})... done`);

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
  console.log("Parsing AI JSON...");
  // Strip markdown code fences if the model added them despite instructions
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = loggedJsonParse("ai.responseJson", cleaned);
  console.log("Parsing AI JSON... done");
  return parsed;
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
  logStep("callAiWithFallback START");
  console.log("[GroqTavily] useSearch:", useSearch, "| hasImage:", !!imageBase64);

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

      // Backend price extraction + currency conversion (see
      // _priceExtraction.ts). Only fires for the single-product analyze.ts
      // prompt shape and only when we actually found something to hand
      // over — otherwise this is a no-op and behavior is unchanged.
      const targetCurrency = extractTargetCurrency(prompt);
      if (targetCurrency) {
        try {
          // Live price now comes from Serper (a live Google SERP call) as
          // the primary source instead of re-mining the Tavily specs/review
          // results above — Serper reflects current listings more directly
          // for pricing specifically. Tavily's `results` (fetched above)
          // stay untouched as the source for searchContext (specs/pros/
          // cons); this block ONLY affects price extraction and never
          // reassigns searchContext.
          let priceRange: any = null;
          try {
            const priceQuery = buildPriceSearchQuery(prompt, targetCurrency);
            const regionHint = CURRENCY_REGION_HINTS[targetCurrency];
            const { results: serperResults } = await searchSerper(priceQuery, {
              gl: regionHint?.gl,
              hl: regionHint?.hl,
            });
            searchQueryCount += 1; // billed Serper call
            priceRange = await computeMarketPriceRange(serperResults, targetCurrency, prompt);
            console.log(
              priceRange
                ? "[GroqTavily] Serper price search found a usable price."
                : "[GroqTavily] Serper price search found nothing usable on first pass."
            );
          } catch (serperErr: any) {
            // Missing SERPER_API_KEY, Serper outage, rate limit, etc. —
            // fall back to the original behavior (price-mine the Tavily
            // results already fetched above) so pricing keeps working even
            // if Serper is unavailable for this request.
            console.error("[GroqTavily] Serper price search failed — falling back to Tavily results for pricing:");
            console.error(serperErr);
            console.error(serperErr?.stack);
            priceRange = await computeMarketPriceRange(results, targetCurrency, prompt);
          }

          // Retry: the generic query above is untargeted, so it often
          // surfaces global listings with no price in the user's currency
          // (or noisy pages the extractor can't trust). If that happened,
          // spend ONE extra call — Serper first, Tavily as a fallback if
          // Serper itself is down — on a query aimed specifically at that
          // currency's regional retailers (and, for Arabic-speaking
          // markets, an Arabic-language query) before giving up. This only
          // fires when the first attempt found nothing, so the common/
          // successful case still costs exactly one extra call.
          if (!priceRange) {
            const retry = buildLocalizedRetryQuery(prompt, targetCurrency);
            if (retry) {
              console.log(
                `[GroqTavily] First-pass price extraction found nothing usable — retrying with localized query: "${retry.query}"`
              );
              try {
                try {
                  const { results: retryResults } = await searchSerper(retry.query, {
                    includeDomains: retry.domains,
                    gl: retry.gl,
                    hl: retry.hl,
                  });
                  searchQueryCount += 1; // billed Serper call
                  priceRange = await computeMarketPriceRange(retryResults, targetCurrency, prompt);
                } catch (retrySerperErr: any) {
                  console.error("[GroqTavily] Localized Serper retry failed — falling back to Tavily for the retry:");
                  console.error(retrySerperErr);
                  const { results: retryResults } = await searchTavily(retry.query, { includeDomains: retry.domains });
                  searchQueryCount += 1; // billed Tavily call
                  priceRange = await computeMarketPriceRange(retryResults, targetCurrency, prompt);
                }
                console.log(
                  priceRange
                    ? "[GroqTavily] Localized retry found a usable price."
                    : "[GroqTavily] Localized retry still found nothing usable — leaving pricing to the model."
                );
              } catch (retryErr: any) {
                console.error("[GroqTavily] Localized retry call failed:");
                console.error(retryErr);
                console.error(retryErr?.stack);
              }
            }
          }

          if (priceRange) {
            console.log(
              `[GroqTavily] Price extraction: found ${priceRange.sampleSize} price(s) in ${priceRange.sourceCurrency}` +
                (priceRange.sourceCurrency !== priceRange.targetCurrency
                  ? ` -> converted to ${priceRange.targetCurrency} (rate ${priceRange.rate})`
                  : "") +
                ` -> min ${priceRange.min}, mid ${priceRange.mid}, max ${priceRange.max} ${priceRange.targetCurrency}`
            );
            searchContext += formatMarketPriceContext(priceRange);
          } else {
            console.log("[GroqTavily] Price extraction: no usable price found in search results — leaving to model.");
          }
        } catch (priceErr: any) {
          // Never let a price-extraction/conversion hiccup break the whole
          // request — just fall back to the model's own reading of the raw
          // search context, same as before this feature existed.
          console.error("[GroqTavily] Price extraction/conversion failed:");
          console.error(priceErr);
          console.error(priceErr?.stack);
        }
      }
    } catch (e: any) {
      console.error("[GroqTavily] Tavily search failed — proceeding on the model's own knowledge only:");
      console.error(e);
      console.error(e?.stack);
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
  const primaryStart = Date.now();
  try {
    const { text, usage } = await callGroqModel(PRIMARY_MODEL, systemPrompt, userPrompt);
    const result = {
      data: tryParseJson(text),
      modelUsed: PRIMARY_MODEL,
      usage: { ...usage, searchQueryCount },
      usedSearch: useSearch,
    };
    console.log(`[GroqTavily] Primary model (${PRIMARY_MODEL}) succeeded in ${Date.now() - primaryStart}ms`);
    logStep("callAiWithFallback SUCCESS (primary)");
    return result;
  } catch (e1: any) {
    console.error(`[GroqTavily] Primary model (${PRIMARY_MODEL}) failed after ${Date.now() - primaryStart}ms:`);
    console.error(e1);
    console.error(e1?.stack);
    if (isRateLimitError(e1)) {
      console.error("[GroqTavily] Primary hit its rate limit — going straight to fallback's separate quota.");
    }
  }

  // 2. Fall back to a different model — own quota bucket, silent to the user
  const fallbackStart = Date.now();
  try {
    const strictSuffix = "\n\nCRITICAL: Return ONLY valid JSON. No markdown, no code fences, no text before or after the JSON object.";
    const { text, usage } = await callGroqModel(FALLBACK_MODEL, systemPrompt, userPrompt + strictSuffix);
    const result = {
      data: tryParseJson(text),
      modelUsed: FALLBACK_MODEL,
      usage: { ...usage, searchQueryCount },
      usedSearch: useSearch,
    };
    console.log(`[GroqTavily] Fallback model (${FALLBACK_MODEL}) succeeded in ${Date.now() - fallbackStart}ms`);
    logStep("callAiWithFallback SUCCESS (fallback)");
    return result;
  } catch (e2: any) {
    console.error(`[GroqTavily] Fallback model (${FALLBACK_MODEL}) also failed after ${Date.now() - fallbackStart}ms:`);
    console.error(e2);
    console.error(e2?.stack);
    logStep("callAiWithFallback FAILED (both models exhausted)");
    throw new Error("ai_unavailable");
  }
}
