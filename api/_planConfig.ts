/**
 * Section 15: Centralized Plan Configuration
 * Single source of truth for all subscription plans, limits, and pricing
 * Used by: approve.ts, analyze.ts, compare.ts, ask.ts, scans-remaining.ts, subscribe.ts
 */

export interface PlanConfig {
  id: string;
  name: string; // e.g., "small_bundle", "medium_bundle", "large_bundle", "smart_shopper", "power_buyer"
  displayName: string; // e.g., "Small Bundle", "Smart Shopper"
  price: number; // in EGP
  currency: string;
  limits: {
    scans: number; // monthly analysis limit
    compares: number; // monthly comparison limit
    chatMessages: number; // monthly chat/advisor messages limit
  };
  description: string;
}

/**
 * All subscription plans with their limits
 * This is the ONLY place where plan limits should be defined
 */
export const PLAN_CONFIGS: Record<string, PlanConfig> = {
  small_bundle: {
    id: "small_bundle",
    name: "small_bundle",
    displayName: "Small Bundle",
    price: 49,
    currency: "EGP",
    limits: {
      scans: 4,
      compares: 0,
      chatMessages: 45,
    },
    description: "4 analyses, 45 chat messages",
  },
  medium_bundle: {
    id: "medium_bundle",
    name: "medium_bundle",
    displayName: "Medium Bundle",
    price: 79,
    currency: "EGP",
    limits: {
      scans: 7,
      compares: 0,
      chatMessages: 90,
    },
    description: "7 analyses, 90 chat messages",
  },
  large_bundle: {
    id: "large_bundle",
    name: "large_bundle",
    displayName: "Large Bundle",
    price: 119,
    currency: "EGP",
    limits: {
      scans: 11,
      compares: 0,
      chatMessages: 150,
    },
    description: "11 analyses, 150 chat messages",
  },
  smart_shopper: {
    id: "smart_shopper",
    name: "smart_shopper",
    displayName: "Smart Shopper",
    price: 150,
    currency: "EGP",
    limits: {
      scans: 16,
      compares: 3,
      chatMessages: 150,
    },
    description: "16 analyses, 3 comparisons, 150 chat messages",
  },
  power_buyer: {
    id: "power_buyer",
    name: "power_buyer",
    displayName: "Power Buyer",
    price: 300,
    currency: "EGP",
    limits: {
      scans: 30,
      compares: 8,
      chatMessages: 400,
    },
    description: "30 analyses, 8 comparisons, 400 chat messages",
  },
};

/**
 * Free tier limits (non-premium users)
 */
export const FREE_TIER_LIMITS = {
  scans: 5, // monthly free analyses
  compares: 0, // free users cannot compare
  chatMessages: 20, // monthly free chat messages
};

/**
 * Default premium tier limits (used as fallback if plan not found)
 * This should NOT be used directly — always fetch from database or PLAN_CONFIGS
 */
export const DEFAULT_PREMIUM_LIMITS = {
  scans: 50,
  compares: 10,
  chatMessages: 150,
};

/**
 * Get plan config by ID
 */
export function getPlanConfig(planId: string): PlanConfig | null {
  return PLAN_CONFIGS[planId] || null;
}

/**
 * Get plan config by price (for validation/matching)
 */
export function getPlanConfigByPrice(price: number): PlanConfig | null {
  return Object.values(PLAN_CONFIGS).find((p) => p.price === price) || null;
}

/**
 * Get all available plans
 */
export function getAllPlans(): PlanConfig[] {
  return Object.values(PLAN_CONFIGS);
}

/**
 * Validate that a plan exists
 */
export function isValidPlan(planId: string): boolean {
  return planId in PLAN_CONFIGS;
}
