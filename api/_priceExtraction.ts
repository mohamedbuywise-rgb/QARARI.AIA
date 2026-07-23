export const SUPPORTED_CURRENCIES = ["USD", "EGP", "SAR", "AED", "KWD", "EUR", "GBP", "QAR", "BHD", "OMR", "JOD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

const CURRENCY_PATTERNS: { code: SupportedCurrency; regex: RegExp }[] = [
  { code: "EGP", regex: /(E£|EGP|\bL\.?E\.?\b|ج\.م|جنيه)/i },
  { code: "SAR", regex: /(SAR|\bS\.?R\.?\b|ر\.س|ريال)/i },
  { code: "AED", regex: /(AED|\bDHS\b|د\.إ|درهم)/i },
  { code: "KWD", regex: /(KWD|\bK\.?D\.?\b|د\.ك|دينار)/i },
  { code: "EUR", regex: /(€|EUR)/i },
  { code: "GBP", regex: /(£|GBP)/i },
  { code: "USD", regex: /(US\$|USD|\$)/i },
];

const REJECT_KEYWORDS = /accessory|cable|cover|case|screen protector|shipping|delivery|refurbished|open box|bundle|combo/i;
const TRUSTED_RETAILERS = ["amazon", "noon", "jumia", "jarir", "extra", "carrefour", "bhphotovideo", "bestbuy", "apple", "samsung"];

interface PriceHit {
  value: number;
  currency: SupportedCurrency;
  url: string;
  title: string;
  weight: number;
}

function getTrustWeight(url: string): number {
  const domain = new URL(url).hostname.toLowerCase();
  for (const trusted of TRUSTED_RETAILERS) {
    if (domain.includes(trusted)) return 2;
  }
  return 1;
}

function extractPrices(text: string, title: string, url: string): PriceHit[] {
  const prices: PriceHit[] = [];
  const numRegex = /\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?/g;
  let match;

  while ((match = numRegex.exec(text)) !== null) {
    const val = parseFloat(match[0].replace(/[,\s]/g, ""));
    if (val < 10 || val > 20_000_000) continue;

    const window = text.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
    let currency: SupportedCurrency | null = null;
    for (const p of CURRENCY_PATTERNS) {
      if (p.regex.test(window)) {
        currency = p.code;
        break;
      }
    }

    if (currency && !REJECT_KEYWORDS.test(window) && !REJECT_KEYWORDS.test(title)) {
      const weight = getTrustWeight(url);
      prices.push({ value: val, currency, url, title, weight });
    }
  }
  return prices;
}

async function getExchangeRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    const json = await res.json();
    return json.rates[to] || 1;
  } catch {
    return 1;
  }
}

function calculateWeightedMedian(values: number[], weights: number[]): number {
  const sorted = values.map((v, i) => ({ value: v, weight: weights[i] })).sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulativeWeight = 0;
  const halfWeight = totalWeight / 2;
  
  for (const item of sorted) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= halfWeight) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

export async function computeMarketPriceRange(results: any[], targetCurrency: SupportedCurrency, prompt: string) {
  let allPrices: PriceHit[] = [];
  for (const r of results) {
    allPrices = allPrices.concat(extractPrices(r.content, r.title, r.url));
  }

  if (allPrices.length === 0) return null;

  // Convert all to target currency
  const convertedPrices: number[] = [];
  const weights: number[] = [];
  
  for (const p of allPrices) {
    const rate = await getExchangeRate(p.currency, targetCurrency);
    convertedPrices.push(p.value * rate);
    weights.push(p.weight);
  }

  convertedPrices.sort((a, b) => a - b);
  const median = calculateWeightedMedian(convertedPrices, weights);
  
  // Filter outliers: 60% to 160% of median
  const filtered: number[] = [];
  const filteredWeights: number[] = [];
  
  for (let i = 0; i < convertedPrices.length; i++) {
    if (convertedPrices[i] >= median * 0.6 && convertedPrices[i] <= median * 1.6) {
      filtered.push(convertedPrices[i]);
      filteredWeights.push(weights[i]);
    }
  }
  
  if (filtered.length === 0) return null;

  const min = Math.round(filtered[0]);
  const max = Math.round(filtered[filtered.length - 1]);
  const mid = Math.round(calculateWeightedMedian(filtered, filteredWeights));

  // Calculate confidence based on sample size
  let confidence = "Low";
  if (filtered.length >= 5) confidence = "High";
  else if (filtered.length >= 2) confidence = "Medium";
  else return null;

  return { 
    min, 
    mid, 
    max, 
    targetCurrency, 
    confidence, 
    validCount: filtered.length,
    sampleSize: filtered.length 
  };
}

export function formatMarketPriceContext(range: any): string {
  if (!range) return "Market price data unavailable.";
  return `
MARKET PRICE DATA (Confidence: ${range.confidence}):
- Currency: ${range.targetCurrency}
- Fair Price Range: ${range.min} - ${range.max}
- Estimated Average: ${range.mid}
- Data Points: ${range.validCount}
  `.trim();
}
