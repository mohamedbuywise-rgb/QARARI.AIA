import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { sendEmail } from "../_resend.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "../_logger.js";

const MONTHLY_DAYS = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    console.warn("[/api/admin/approve] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    console.log("Checking authentication...");
    if (!isValidAdmin(req)) {
      console.warn("[/api/admin/approve] Rejected — invalid admin credentials");
      return res.status(401).json({ error: "unauthorized" });
    }
    console.log("Authentication OK");

    const { requestId } = req.body || {};
    if (!requestId) {
      console.warn("[/api/admin/approve] Missing requestId");
      return res.status(400).json({ error: "missing_request_id" });
    }
    console.log("[/api/admin/approve] requestId:", requestId);

    const admin = getSupabaseAdmin();

    console.log("Loading subscription request...");
    const { data: reqRow, error: reqErr } = await admin
      .from("subscription_requests")
      .select("*, users(id, email)")
      .eq("id", requestId)
      .single();

    if (reqErr || !reqRow) {
      console.error("[/api/admin/approve] request_not_found. Supabase error:", reqErr);
      return res.status(404).json({ error: "request_not_found" });
    }
    if (reqRow.status !== "pending_review") {
      console.warn("[/api/admin/approve] Request already reviewed. status:", reqRow.status);
      return res.status(409).json({ error: "already_reviewed" });
    }
    console.log("[/api/admin/approve] Request loaded. userId:", reqRow.user_id);

    const now = new Date();
    const days = MONTHLY_DAYS;
    const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // Section 16: server-computed dates, extends/restarts on renewal
    const { data: beforeUser } = await admin.from("users").select("*").eq("id", reqRow.user_id).single();

    console.log("Saving database...");
    await admin
      .from("users")
      .update({
        tier: "premium",
        subscription_start_date: now.toISOString(),
        subscription_end_date: endDate.toISOString(),
      })
      .eq("id", reqRow.user_id);

    await admin
      .from("subscription_requests")
      .update({ status: "approved", reviewed_by: "admin", reviewed_at: now.toISOString() })
      .eq("id", requestId);

    // Section 24: audit log
    await admin.from("admin_audit_log").insert({
      admin_identity: "admin",
      action_type: "approve_subscription",
      target_user_id: reqRow.user_id,
      before_value: beforeUser,
      after_value: { tier: "premium", subscription_end_date: endDate.toISOString() },
    });
    console.log("Saving database... done");

    if (reqRow.users?.email) {
      await sendEmail(
        reqRow.users.email,
        "تم تفعيل اشتراك بريميوم — Qarari.AI",
        `<p>تم تفعيل اشتراكك في بريميوم بنجاح! صالح حتى ${endDate.toLocaleDateString("ar-EG")}.</p>
         <p>Your Premium subscription is now active until ${endDate.toDateString()}.</p>`
      );
    }

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
