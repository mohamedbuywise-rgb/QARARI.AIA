import {
  Smartphone, Laptop, Watch, Headphones, Camera, Tv, Car,
  Footprints, ShoppingBag, Gamepad2, Package,
} from "lucide-react";
import type { ComponentType } from "react";

interface IconProps {
  className?: string;
  strokeWidth?: number;
}

type IconComponent = ComponentType<IconProps>;

const keywordMap: { keywords: string[]; icon: IconComponent }[] = [
  { keywords: ["phone", "iphone", "samsung", "galaxy", "pixel", "موبايل", "تليفون", "هاتف"], icon: Smartphone },
  { keywords: ["laptop", "macbook", "notebook", "لابتوب", "كمبيوتر"], icon: Laptop },
  { keywords: ["watch", "ساعة"], icon: Watch },
  { keywords: ["headphone", "airpods", "earbuds", "سماعة"], icon: Headphones },
  { keywords: ["camera", "كاميرا"], icon: Camera },
  { keywords: ["tv", "television", "تليفزيون"], icon: Tv },
  { keywords: ["car", "سيارة"], icon: Car },
  { keywords: ["shoe", "جزمة", "sneaker"], icon: Footprints },
  { keywords: ["bag", "شنطة"], icon: ShoppingBag },
  { keywords: ["console", "playstation", "xbox"], icon: Gamepad2 },
];

function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLowerCase()
    .trim();
}

export function getCategoryIcon(productName: string): IconComponent {
  if (!productName || productName.trim().length === 0) return Package;
  const normalized = normalizeArabic(productName);
  for (const entry of keywordMap) {
    const normalizedKeywords = entry.keywords.map(normalizeArabic);
    if (normalizedKeywords.some((kw) => normalized.includes(kw))) {
      return entry.icon;
    }
  }
  return Package;
}

// Maps the closed category set returned by api/icon.ts (Groq classification)
// to the same icon set above. Keeping this separate from getCategoryIcon
// means the live-typing icon on the input form (no API call yet) and the
// server-classified icon on the report page (after a real Groq call) can
// each use the lookup that actually applies to them.
const iconCategoryMap: Record<string, IconComponent> = {
  phone: Smartphone,
  laptop: Laptop,
  watch: Watch,
  headphones: Headphones,
  camera: Camera,
  tv: Tv,
  car: Car,
  shoes: Footprints,
  bag: ShoppingBag,
  console: Gamepad2,
  other: Package,
};

// productName is used as a fallback so the icon never regresses to a plain
// box while the Groq classification request is still in flight or failed.
export function getIconForCategory(category: string | null | undefined, productName: string): IconComponent {
  if (category && iconCategoryMap[category]) return iconCategoryMap[category];
  return getCategoryIcon(productName);
}