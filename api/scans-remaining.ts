import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";

const FREE_MONTHLY_LIMIT = 5;
const PREMIUM_MONTHLY_LIMIT = 50; // fair-use cap for paid subscribers, prevents runaway AI cost from outlier usage

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  try {
    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user);
    const now = new Date();

    if (user) {
      console.log("[/api/scans-remaining] Loading user row:", user.id);
      const { data: row } = await admin
        .from("users")
        .select("tier, scans_used_this_month, scans_reset_at")
        .eq("id", user.id)
        .single();

      if (!row) {
        console.error("[/api/scans-remaining] user_not_found:", user.id);
        return res.status(404).json({ error: "user_not_found" });
      }

      const resetAt = new Date(row.scans_reset_at);
      const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
      const used = needsReset ? 0 : row.scans_used_this_month;

      if (row.tier === "premium") {
        const remaining = Math.max(0, PREMIUM_MONTHLY_LIMIT - used);
        console.log("Returning response... premium remaining:", remaining);
        logRequestSuccess(start);
        return res.status(200).json({ unlimited: false, remaining, max: PREMIUM_MONTHLY_LIMIT });
      }

      const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used);
      console.log("Returning response... free remaining:", remaining);
      logRequestSuccess(start);
      return res.status(200).json({ unlimited: false, remaining, max: FREE_MONTHLY_LIMIT });
    } else {
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      console.log("[/api/scans-remaining] Guest request. IP:", ip);
      const { data: row } = await admin.from("guest_usage").select("*").eq("ip_address", ip).single();

      let used = 0;
      if (row) {
        const resetAt = new Date(row.scans_reset_at);
        const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
        used = needsReset ? 0 : row.scans_used_this_month;
      }
      const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used);
      console.log("Returning response... guest remaining:", remaining);
      logRequestSuccess(start);
      return res.status(200).json({ unlimited: false, remaining, max: FREE_MONTHLY_LIMIT });
    }
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
