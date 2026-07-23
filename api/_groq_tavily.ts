import { logStep, logEnvPresence, loggedFetch, loggedJsonParse } from "./_logger.js";
import { computeMarketPriceRange, formatMarketPriceContext, isSupportedCurrency } from "./_priceExtraction.js";

const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

export interface AiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueryCount: number;
}

interface SerperResult {
  title: string;
  url: string;
  content: string;
  rawContent: string | null;
}

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

async function smartAdaptiveSearch(product: string, currency: string, region: { gl: string; hl: string }): Promise<{ results: SerperResult[]; searchCount: number }> {
  const state: SearchState = {
    allResults: [],
    searchCount: 0,
    lastMedian: null,
    lastConfidence: 0,
    validPriceCount: 0
  };

  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const maxSearches = 6;

  // SEARCH 1: Official Store
  console.log("[SmartSearch] Search 1: Official Store");
  let query1 = `${product} price ${currency} (${retailers.official})`;
  let results1 = await searchSerper(query1, region);
  state.allResults.push(...results1);
  state.searchCount++;
  console.log(`[SmartSearch] Search 1 returned ${results1.length} results`);

  // Check early stop condition 1: Confidence >= 90%
  let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`);
  if (priceAnalysis?.confidence === "High" && priceAnalysis.validCount >= 5) {
    console.log("[SmartSearch] Early stop: Confidence >= 90%");
    return { results: state.allResults, searchCount: state.searchCount };
  }

  // SEARCH 2: Largest Marketplace
  console.log("[SmartSearch] Search 2: Largest Marketplace");
  const marketplaceQuery = retailers.marketplace.map(m => `site:${m}`).join(" OR ");
  let query2 = `${product} price ${currency} (${marketplaceQuery})`;
  let results2 = await searchSerper(query2, region);
  state.allResults.push(...results2);
  state.searchCount++;
  console.log(`[SmartSearch] Search 2 returned ${results2.length} results`);

  // Check early stop condition 2: At least 5 valid prices AND median change < 1%
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`);
  if (priceAnalysis?.validCount >= 5) {
    const medianChange = state.lastMedian ? Math.abs(priceAnalysis.mid - state.lastMedian) / state.lastMedian : 1;
    if (medianChange < 0.01) {
      console.log("[SmartSearch] Early stop: 5+ prices with <1% median change");
      return { results: state.allResults, searchCount: state.searchCount };
    }
    state.lastMedian = priceAnalysis.mid;
  }

  // Check early stop condition 3: Last two searches added no new valid prices
  const pricesBefore = state.validPriceCount;
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`);
  state.validPriceCount = priceAnalysis?.validCount || 0;
  
  if (state.validPriceCount === pricesBefore && state.searchCount >= 2) {
    console.log("[SmartSearch] Early stop: No new valid prices in last searches");
    return { results: state.allResults, searchCount: state.searchCount };
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

  return { results: state.allResults, searchCount: state.searchCount };
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

  if (useSearch) {
    const targetCurrency = extractTargetCurrency(prompt) || "EGP";
    const product = extractProductName(prompt);
    const region = CURRENCY_REGION_HINTS[targetCurrency] || { gl: "eg", hl: "ar" };

    // Execute Smart Adaptive Search
    const { results, searchCount } = await smartAdaptiveSearch(product, targetCurrency, region);
    allResults = results;
    searchQueryCount = searchCount;

    const priceRange = await computeMarketPriceRange(allResults, targetCurrency as any, prompt);
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
      usedSearch: useSearch
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
      usedSearch: useSearch
    };
  }
}
