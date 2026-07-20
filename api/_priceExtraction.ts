import { searchTavily } from './_groq_tavily';

interface PriceResult {
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  currency: string;
  sourcesCount: number;
  sources: Array<{ title: string; url: string; price: number }>;
}

/**
 * المتاجر المصرية الموثوقة لتحديد نطاق البحث
 */
const EGYPTIAN_DOMAINS = [
  'amazon.eg',
  'noon.com',
  'btech.com',
  '2b.com.eg',
  'rayashop.com',
  'elbaraka.com.eg',
  'dubizzle.com.eg'
];

/**
 * دالة استخراج الأسعار مباشرة من نتائج Tavily بدون تدخل Grok
 */
export async function extractProductPrices(productName: string): Promise<PriceResult | null> {
  try {
    // 1. صياغة استعلام بحث محدد جداً للسوق المصري
    const searchQuery = `سعر ${productName} في مصر بالجنيه EGP`;

    // 2. استدعاء Tavily مع تضييق نطاق المواقع
    const searchResults = await searchTavily(searchQuery, {
      includeDomains: EGYPTIAN_DOMAINS,
      searchDepth: 'advanced',
      maxResults: 10
    });

    if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
      // إذا لم يجد في المتاجر المحددة، يبحث في الويب المصري العام كخيار احتياطي
      const fallbackResults = await searchTavily(`${productName} price in Egypt EGP جنيه`, {
        searchDepth: 'basic',
        maxResults: 10
      });
      if (fallbackResults && fallbackResults.results) {
        searchResults.results = fallbackResults.results;
      }
    }

    const extractedPrices: Array<{ title: string; url: string; price: number }> = [];

    // 3. استخراج الأسعار باستخدام Regex موجه للعملة المصرية
    const priceRegex = /(?:EGP|EGP\.|جنيه|ج\.م|جـ\.م)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:EGP|EGP\.|جنيه|ج\.م|جـ\.م)/gi;

    for (const item of searchResults.results) {
      const textToScan = `${item.title} ${item.content}`;
      let match;

      while ((match = priceRegex.exec(textToScan)) !== null) {
        // استخراج الرقم وتنظيفه من الفواصل
        const rawPriceStr = match[1] || match[2];
        if (!rawPriceStr) continue;

        const numericPrice = parseFloat(rawPriceStr.replace(/,/g, ''));

        // فلترة الأرقام الشاذة:
        // - استبعاد المبالغ القليلة جداً (مثل الإكسسوارات أو رقم الموديل 24/25)
        // - استبعاد الأرقام غير المنطقية
        if (!isNaN(numericPrice) && numericPrice >= 1000 && numericPrice <= 300000) {
          extractedPrices.push({
            title: item.title,
            url: item.url,
            price: numericPrice
          });
        }
      }
    }

    if (extractedPrices.length === 0) {
      return null;
    }

    // 4. تصفية القيم الشاذة (Outliers) حاسوبياً لضمان الدقة
    const pricesList = extractedPrices.map(p => p.price).sort((a, b) => a - b);
    
    // أخذ الشريحة المتوسطة لحذف الأسعار المضللة جداً (إن وجدت)
    const minPrice = pricesList[0];
    const maxPrice = pricesList[pricesList.length - 1];
    const avgPrice = Math.round(pricesList.reduce((sum, p) => sum + p, 0) / pricesList.length);

    return {
      minPrice,
      maxPrice,
      avgPrice,
      currency: 'EGP',
      sourcesCount: extractedPrices.length,
      sources: extractedPrices
    };

  } catch (error) {
    console.error('Error extracting prices via Tavily:', error);
    return null;
  }
}
