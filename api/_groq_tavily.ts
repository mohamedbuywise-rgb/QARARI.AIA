// api/_groq_tavily.ts

export interface TavilySearchOptions {
  includeDomains?: string[];
  searchDepth?: 'basic' | 'advanced';
  maxResults?: number;
}

export async function searchTavily(query: string, options: TavilySearchOptions = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set');
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: options.searchDepth || 'basic',
      include_domains: options.includeDomains || [],
      max_results: options.maxResults || 8,
      include_answer: false
    })
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.statusText}`);
  }

  return await response.json();
}
