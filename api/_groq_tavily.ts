import { logStep, logEnvPresence, loggedFetch, loggedJsonParse } from "./_logger.js";
import { computeMarketPriceRange, formatMarketPriceContext, isSupportedCurrency, extractListingPrice, type SupportedCurrency } from "./_priceExtraction.js";

const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

export interface AiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueryCount: number;
}

export interface SerperResult {
  title: string;
  url: string;
  content: string;
  rawContent: string | null;
}

// Feature flag: only show a B.TECH card in the retailer price comparison
// once we've confirmed an affiliate/commission deal with them. Toggle via
// env var — no code change needed to flip it on later.
export const SHOW_BTECH_COMPARISON = process.env.SHOW_BTECH_COMPARISON === "true";

interface CountryRetailerMap {
  official: string;
  marketplace: string[];
}

const COUNTRY_RETAILERS: Record<string, CountryRetailerMap> = {
  EGP: {
    official: "site:apple.com OR site:samsung.com OR site:store.sony.com",
    marketplace: ["amazon.eg", "jumia.com.eg", "btech.com", "noon.com"]
  },
  SAR: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.sa", "jarir.com", "extra.com", "noon.com"]
  },
  AED: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.ae", "noon.com", "carrefour.ae"]
  },
  KWD: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["xcite.com", "amazon.com"]
  },
  USD: {
    official: "site:apple.com OR site:samsung.com OR site:bestbuy.com",
    marketplace: ["amazon.com", "bhphotovideo.com", "newegg.com"]
  },
  EUR: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.de", "amazon.fr", "amazon.it"]
  }
};

// Secondhand/open-box marketplaces, used when condition is "likeNew"
// (كسر زيرو) or "used" (مستعمل) — searching new-retailer sites for these
// conditions returns nothing relevant, since those sites only sell new.
const USED_MARKETPLACES: Record<string, string[]> = {
  EGP: ["dubizzle.com.eg", "eg.opensooq.com"],
  SAR: ["opensooq.com", "haraj.com.sa"],
  AED: ["dubizzle.com"],
  KWD: ["opensooq.com"],
  USD: ["ebay.com", "swappa.com"],
  EUR: ["ebay.de"],
};

async function searchSerper(query: string, opts: { gl?: string; hl?: string } = {}): Promise<SerperResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("Missing SERPER_API_KEY");

  try {
    const res = await loggedFetch("serper.search", "https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        q: query,
        num: 10,
        ...(opts.gl ? { gl: opts.gl } : {}),
        ...(opts.hl ? { hl: opts.hl } : {}),
      }),
    });

    if (!res.ok) return [];
    const json = await res.json();
    const organic = Array.isArray(json?.organic) ? json.organic : [];
    return organic.map((r: any) => ({
      title: r.title || "",
      url: r.link || "",
      content: r.snippet || "",
      rawContent: null,
    }));
  } catch (error) {
    console.error("[Serper] Error:", error);
    return [];
  }
}

function extractTargetCurrency(prompt: string): string | null {
  const match = prompt.match(/OFFERED PRICE:\s*[\d.,\s]+\s*([A-Za-z]{3})\b/);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return isSupportedCurrency(code) ? code : null;
}

function extractProductName(prompt: string): string {
  const match = prompt.match(/PRODUCT:\s*(.+)/i);
  return match ? match[1].trim() : "";
}

// The specs/variant line lives on its own line in the prompt: "USAGE PROFILE
// — purpose: X, expected duration: Y, other specs/preferences: Z". Pull just
// the Z part so the search query can include it (storage/RAM/size/etc.) —
// otherwise Serper only ever searches the bare product name and returns
// prices spanning every variant/SKU, which is what was producing the
// misleadingly wide market range.
function extractSpecs(prompt: string): string {
  const match = prompt.match(/other specs\/preferences:\s*(.+)/i);
  if (!match) return "";
  const value = match[1].trim();
  return value.toLowerCase() === "none" ? "" : value;
}

// "PRODUCT CONDITION: new|likeNew|used" — this decides which sites we search
// and which listings we keep. Searching new-retailer sites for a "used"
// request, or keeping refurbished/open-box listings for a "new" request,
// mixes conditions together and produces a misleadingly wide price range.
function extractCondition(prompt: string): "new" | "likeNew" | "used" {
  const match = prompt.match(/PRODUCT CONDITION:\s*(\w+)/i);
  const value = (match?.[1] || "new").toLowerCase();
  if (value === "used") return "used";
  if (value === "likenew") return "likeNew";
  return "new";
}

// A short bilingual qualifier appended to the query text so Serper itself
// biases toward the right condition, on top of restricting which domains we search.
function conditionQualifier(condition: "new" | "likeNew" | "used"): string {
  if (condition === "likeNew") return '("كسر زيرو" OR "open box" OR "like new")';
  if (condition === "used") return "(مستعمل OR used OR \"second hand\")";
  return "";
}

function buildSearchTerm(product: string, specs: string): string {
  return specs ? `${product} ${specs}` : product;
}

const CURRENCY_REGION_HINTS: Record<string, { gl: string; hl: string }> = {
  EGP: { gl: "eg", hl: "ar" },
  SAR: { gl: "sa", hl: "ar" },
  AED: { gl: "ae", hl: "ar" },
  KWD: { gl: "kw", hl: "ar" },
  USD: { gl: "us", hl: "en" },
  EUR: { gl: "de", hl: "en" },
};

interface SearchState {
  allResults: SerperResult[];
  searchCount: number;
  lastMedian: number | null;
  lastConfidence: number;
  validPriceCount: number;
}

async function smartAdaptiveSearch(product: string, currency: string, region: { gl: string; hl: string }, condition: "new" | "likeNew" | "used"): Promise<{ results: SerperResult[]; searchCount: number; retailerSearchResults: SerperResult[] }> {
  const state: SearchState = {
    allResults: [],
    searchCount: 0,
    lastMedian: null,
    lastConfidence: 0,
    validPriceCount: 0
  };

  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const usedSites = USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD;
  const qualifier = conditionQualifier(condition);
  const maxSearches = 6;

  // New-condition retailers only sell new stock, so they're irrelevant when
  // hunting for likeNew/used — skip straight to secondhand marketplaces.
  // (No official retail price comparison makes sense for used/likeNew, so
  // retailerSearchResults stays empty for this branch.)
  if (condition !== "new") {
    console.log(`[SmartSearch] Condition=${condition}: searching secondhand marketplaces`);
    const usedQuery = usedSites.map(m => `site:${m}`).join(" OR ");
    let query1 = `${product} price ${currency} ${qualifier} (${usedQuery})`;
    let results1 = await searchSerper(query1, region);
    state.allResults.push(...results1);
    state.searchCount++;

    let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
    if (priceAnalysis?.confidence === "High" && priceAnalysis.validCount >= 5) {
      return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: [] };
    }

    // Broaden with a plain query (still condition-qualified) if not enough signal yet
    let query2 = `${product} ${qualifier} price ${currency}`;
    let results2 = await searchSerper(query2, region);
    state.allResults.push(...results2);
    state.searchCount++;

    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: [] };
  }

  // SEARCH 1: Official Store
  console.log("[SmartSearch] Search 1: Official Store");
  let query1 = `${product} price ${currency} (${retailers.official})`;
  let results1 = await searchSerper(query1, region);
  state.allResults.push(...results1);
  state.searchCount++;
  console.log(`[SmartSearch] Search 1 returned ${results1.length} results`);

  // Check early stop condition 1: Confidence >= 90%
  let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
  if (priceAnalysis?.confidence === "High" && priceAnalysis.validCount >= 5) {
    console.log("[SmartSearch] Early stop: Confidence >= 90%");
    // Official-store-only stop means we never ran the marketplace (Jumia/Noon)
    // query, so there's nothing to build a retailer price comparison from.
    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: [] };
  }

  // SEARCH 2: Largest Marketplace
  console.log("[SmartSearch] Search 2: Largest Marketplace");
  const marketplaceQuery = retailers.marketplace.map(m => `site:${m}`).join(" OR ");
  let query2 = `${product} price ${currency} (${marketplaceQuery})`;
  let results2 = await searchSerper(query2, region);
  state.allResults.push(...results2);
  state.searchCount++;
  console.log(`[SmartSearch] Search 2 returned ${results2.length} results`);

  // These are the results that feed the per-retailer price comparison shown
  // in ReportScreen — reused as-is, no extra Serper call.
  const retailerSearchResults = results2;

  // Check early stop condition 2: At least 5 valid prices AND median change < 1%
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
  if (priceAnalysis?.validCount >= 5) {
    const medianChange = state.lastMedian ? Math.abs(priceAnalysis.mid - state.lastMedian) / state.lastMedian : 1;
    if (medianChange < 0.01) {
      console.log("[SmartSearch] Early stop: 5+ prices with <1% median change");
      return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
    }
    state.lastMedian = priceAnalysis.mid;
  }

  // Check early stop condition 3: Last two searches added no new valid prices
  const pricesBefore = state.validPriceCount;
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
  state.validPriceCount = priceAnalysis?.validCount || 0;
  
  if (state.validPriceCount === pricesBefore && state.searchCount >= 2) {
    console.log("[SmartSearch] Early stop: No new valid prices in last searches");
    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
  }

  // If confidence still below 90%, execute ONE additional search (Google Shopping)
  if (state.searchCount < maxSearches && (!priceAnalysis || priceAnalysis.confidence !== "High")) {
    console.log("[SmartSearch] Search 3: Google Shopping results");
    let query3 = `${product} price ${currency}`;
    let results3 = await searchSerper(query3, region);
    state.allResults.push(...results3);
    state.searchCount++;
    console.log(`[SmartSearch] Search 3 returned ${results3.length} results`);
  }

  return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
}

async function callGroqModel(model: string, system: string, user: string) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await loggedFetch("groq.chat", "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  return res.json();
}

export async function callAiWithFallback(
  prompt: string,
  imageBase64?: any,
  useSearch: boolean = true
): Promise<any> {
  let searchContext = "";
  let searchQueryCount = 0;
  let allResults: SerperResult[] = [];
  let retailerSearchResults: SerperResult[] = [];
  let targetCurrencyUsed = "EGP";

  if (useSearch) {
    const targetCurrency = extractTargetCurrency(prompt) || "EGP";
    targetCurrencyUsed = targetCurrency;
    const product = extractProductName(prompt);
    const specs = extractSpecs(prompt);
    const condition = extractCondition(prompt);
    const searchTerm = buildSearchTerm(product, specs);
    const region = CURRENCY_REGION_HINTS[targetCurrency] || { gl: "eg", hl: "ar" };

    // Execute Smart Adaptive Search
    const { results, searchCount, retailerSearchResults: retailerResults } = await smartAdaptiveSearch(searchTerm, targetCurrency, region, condition);
    allResults = results;
    searchQueryCount = searchCount;
    retailerSearchResults = retailerResults;

    const priceRange = await computeMarketPriceRange(allResults, targetCurrency as any, prompt, condition);
    if (priceRange) {
      searchContext = formatMarketPriceContext(priceRange);
    }
    
    // Add top snippets for reasoning
    searchContext += "\n\nSEARCH SNIPPETS:\n" + allResults.slice(0, 10).map(r => `- ${r.title}: ${r.content}`).join("\n");
  }

  const systemPrompt = "You are a purchase-decision analyst. Respond with ONLY a single valid JSON object.";
  const userPrompt = `${prompt}\n\nSEARCH CONTEXT:\n${searchContext}`;

  try {
    const json = await callGroqModel(PRIMARY_MODEL, systemPrompt, userPrompt);
    return {
      data: JSON.parse(json.choices[0].message.content),
      modelUsed: PRIMARY_MODEL,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        searchQueryCount
      },
      usedSearch: useSearch,
      retailerSearchResults,
      currency: targetCurrencyUsed
    };
  } catch (e) {
    const json = await callGroqModel(FALLBACK_MODEL, systemPrompt, userPrompt);
    return {
      data: JSON.parse(json.choices[0].message.content),
      modelUsed: FALLBACK_MODEL,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        searchQueryCount
      },
      usedSearch: useSearch,
      retailerSearchResults,
      currency: targetCurrencyUsed
    };
  }
}

export interface AlternativeInput {
  name: string;
  estimatedPrice: number;
  reason: { ar: string; en: string };
  whySuitable: { ar: string; en: string };
}

export interface EnrichedAlternative extends AlternativeInput {
  medianPrice: number | null;
  priceRangeMin: number | null;
  priceRangeMax: number | null;
  confidence: "High" | "Medium" | "Low" | "Unknown";
  priceSource: "market_search" | "ai_estimate";
}

// Runs one lightweight, condition-matched Serper search per alternative and
// replaces the model's guessed estimatedPrice with a real median wherever
// the search finds enough data. This is what makes "بدائل أفضل" priced in
// the SAME condition the user asked about (new vs كسر زيرو vs مستعمل)
// instead of the model's own — often new-condition — assumption.
// Capped at MAX_ENRICHED to bound the extra Serper cost per analysis.
const MAX_ENRICHED_ALTERNATIVES = 4;

export async function enrichAlternativesWithMarketPrices(
  alternatives: AlternativeInput[],
  currency: string,
  condition: "new" | "likeNew" | "used"
): Promise<{ enriched: EnrichedAlternative[]; searchQueryCount: number }> {
  const region = CURRENCY_REGION_HINTS[currency] || { gl: "eg", hl: "ar" };
  const qualifier = conditionQualifier(condition);
  let searchQueryCount = 0;

  const results = await Promise.all(
    alternatives.map(async (alt, i): Promise<EnrichedAlternative> => {
      if (i >= MAX_ENRICHED_ALTERNATIVES) {
        return { ...alt, medianPrice: null, priceRangeMin: null, priceRangeMax: null, confidence: "Unknown", priceSource: "ai_estimate" };
      }

      const sites =
        condition === "new"
          ? (COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD).marketplace
          : (USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD);
      const siteFilter = sites.map(s => `site:${s}`).join(" OR ");
      const query = `${alt.name} price ${currency} ${qualifier} (${siteFilter})`;

      const serperResults = await searchSerper(query, region);
      searchQueryCount++;

      const priceRange = await computeMarketPriceRange(serperResults, currency as any, `PRODUCT: ${alt.name}`, condition);

      if (!priceRange) {
        return { ...alt, medianPrice: null, priceRangeMin: null, priceRangeMax: null, confidence: "Unknown", priceSource: "ai_estimate" };
      }

      return {
        ...alt,
        estimatedPrice: priceRange.mid, // override the model's guess with a real, condition-matched median
        medianPrice: priceRange.mid,
        priceRangeMin: priceRange.min,
        priceRangeMax: priceRange.max,
        confidence: priceRange.confidence,
        priceSource: "market_search",
      };
    })
  );

  return { enriched: results, searchQueryCount };
}

export interface RetailerPrice {
  retailer: string;
  price: number;
  url: string;
  currency: string;
}

// Retailers eligible for the ReportScreen price comparison, matched against
// each result's hostname. B.TECH is included only behind SHOW_BTECH_COMPARISON.
function getComparisonRetailers(): { domain: string; name: string }[] {
  const retailers = [
    { domain: "jumia.com.eg", name: "Jumia" },
    { domain: "amazon.eg", name: "Amazon" },
    { domain: "noon.com", name: "Noon" },
  ];
  if (SHOW_BTECH_COMPARISON) {
    retailers.push({ domain: "btech.com", name: "B.TECH" });
  }
  return retailers;
}

function hostnameMatches(url: string, domain: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/**
 * Builds a per-retailer price comparison (Jumia/Amazon/Noon, optionally
 * B.TECH) straight from the Search 2 ("Largest Marketplace") results
 * already fetched by smartAdaptiveSearch — no additional Serper query.
 *
 * Price extraction reuses the same currency-aware, noise-filtered
 * extractPrices() logic as the main market-price calculation (see
 * _priceExtraction.ts) instead of a naive "smallest number in the text"
 * regex — that naive approach is what made prices unreliable before (it
 * could latch onto a rating count, a spec number, or an unrelated figure
 * in the snippet with no currency check at all). Listings whose price
 * isn't in the report's own currency are skipped rather than silently
 * converted, so what's shown always matches the currency on screen.
 */
export function extractRetailerPrices(results: SerperResult[], currency: string): RetailerPrice[] {
  const retailers = getComparisonRetailers();
  const prices: RetailerPrice[] = [];
  if (!isSupportedCurrency(currency)) return prices;
  const targetCurrency = currency as SupportedCurrency;

  for (const { domain, name } of retailers) {
    let best: { price: number; url: string } | null = null;

    for (const r of results) {
      if (!r.url || !hostnameMatches(r.url, domain)) continue;

      const price = extractListingPrice(r.content, r.title, r.url, targetCurrency);
      if (price === null) continue;

      if (!best || price < best.price) {
        best = { price, url: r.url };
      }
    }

    if (best) {
      prices.push({ retailer: name, price: best.price, url: best.url, currency });
    }
  }

  return prices;
}
