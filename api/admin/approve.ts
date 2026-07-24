import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { sendEmail } from "../_resend.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "../_logger.js";
import { getPlanConfig } from "../_planConfig.js";

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
    
    // Section 15: Use centralized plan config (single source of truth)
    const planConfig = getPlanConfig(reqRow.plan);
    if (!planConfig) {
      console.error("[/api/admin/approve] unknown plan:", reqRow.plan);
      return res.status(400).json({ error: "unknown_plan" });
    }

    const now = new Date();
    // All subscription plans are one-time purchases (no auto-renewal) for now
    const endDate = null;

    const { data: beforeUser } = await admin.from("users").select("*").eq("id", reqRow.user_id).single();

    console.log("Saving database...");
    const updateData: any = {
      tier: "premium",
      current_plan_name: reqRow.plan,
      subscription_start_date: now.toISOString(),
      subscription_end_date: endDate,
      // Section 15: Store plan limits from centralized config
      scans_limit_this_month: planConfig.limits.scans,
      compares_limit_this_month: planConfig.limits.compares,
      chat_messages_limit: planConfig.limits.chatMessages,
      price_alerts_limit: 0,
      can_export_pdf: false,
    };

    // Reset usage counters when a new plan is activated
    updateData.scans_used_this_month = 0;
    updateData.compares_used_this_month = 0;
    updateData.chat_messages_used = 0;
    updateData.price_alerts_used = 0;

    await admin
      .from("users")
      .update(updateData)
      .eq("id", reqRow.user_id);

    await admin
      .from("subscription_requests")
      .update({ status: "approved", reviewed_by: "admin", reviewed_at: now.toISOString() })
      .eq("id", requestId);

    await admin.from("admin_audit_log").insert({
      admin_identity: "admin",
      action_type: "approve_subscription",
      target_user_id: reqRow.user_id,
      before_value: beforeUser,
      after_value: updateData,
    });
    console.log("Saving database... done");

    if (reqRow.users?.email) {
      const planDisplayName = reqRow.plan.replace('_', ' ').toUpperCase();
      await sendEmail(
        reqRow.users.email,
        `تم تفعيل باقة ${planDisplayName} — Qarari.AI`,
        `<p>تم تفعيل باقتك (${planDisplayName}) بنجاح!</p>
         ${endDate ? `<p>صالحة حتى ${endDate.toLocaleDateString("ar-EG")}.</p>` : '<p>هذه الباقة لا تنتهي بصلاحية زمنية.</p>'}
         <p>Your ${planDisplayName} plan is now active!</p>`
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
