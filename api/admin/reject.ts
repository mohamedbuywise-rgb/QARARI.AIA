import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "../_logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    console.warn("[/api/admin/reject] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    console.log("Checking authentication...");
    if (!isValidAdmin(req)) {
      console.warn("[/api/admin/reject] Rejected — invalid admin credentials");
      return res.status(401).json({ error: "unauthorized" });
    }
    console.log("Authentication OK");

    const { requestId, reason } = req.body || {};
    if (!requestId) {
      console.warn("[/api/admin/reject] Missing requestId");
      return res.status(400).json({ error: "missing_request_id" });
    }
    console.log("[/api/admin/reject] requestId:", requestId, "| reason:", reason);

    const admin = getSupabaseAdmin();
    console.log("Saving database...");
    const { error } = await admin
      .from("subscription_requests")
      .update({ status: "rejected", reject_reason: reason || null, reviewed_by: "admin", reviewed_at: new Date().toISOString() })
      .eq("id", requestId)
      .eq("status", "pending_review");

    if (error) {
      console.error("[/api/admin/reject] Supabase update failed:", error);
      return res.status(500).json({ error: "server_error" });
    }
    console.log("Saving database... done");

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
