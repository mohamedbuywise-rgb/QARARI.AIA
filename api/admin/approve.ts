import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { sendEmail } from "../_resend.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "../_logger.js";

interface PlanConfig {
  tier: string;
  days: number | null; // null means no expiration
  scans: number;
  chatMessages: number;
  compares: number;
  priceAlerts: number;
  canExportPdf: boolean;
}

const PLAN_CONFIGS: Record<string, PlanConfig> = {
  small_bundle: { tier: "premium", days: null, scans: 3, chatMessages: 45, compares: 0, priceAlerts: 0, canExportPdf: false },
  medium_bundle: { tier: "premium", days: null, scans: 6, chatMessages: 90, compares: 0, priceAlerts: 0, canExportPdf: false },
  large_bundle: { tier: "premium", days: null, scans: 10, chatMessages: 150, compares: 0, priceAlerts: 0, canExportPdf: false },
  smart_shopper: { tier: "premium", days: 30, scans: 50, chatMessages: 150, compares: 10, priceAlerts: 20, canExportPdf: false },
  power_buyer: { tier: "premium", days: 30, scans: 100, chatMessages: 400, compares: 25, priceAlerts: 50, canExportPdf: true },
};

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
    
    const planConfig = PLAN_CONFIGS[reqRow.plan];
    if (!planConfig) {
      console.error("[/api/admin/approve] unknown plan:", reqRow.plan);
      return res.status(400).json({ error: "unknown_plan" });
    }

    const now = new Date();
    let endDate = null;
    if (planConfig.days) {
      endDate = new Date(now.getTime() + planConfig.days * 24 * 60 * 60 * 1000);
    }

    const { data: beforeUser } = await admin.from("users").select("*").eq("id", reqRow.user_id).single();

    console.log("Saving database...");
    const updateData: any = {
      tier: planConfig.tier,
      current_plan_name: reqRow.plan,
      subscription_start_date: now.toISOString(),
      subscription_end_date: endDate ? endDate.toISOString() : null,
      chat_messages_limit: planConfig.chatMessages,
      price_alerts_limit: planConfig.priceAlerts,
      can_export_pdf: planConfig.canExportPdf,
    };

    // If it's a one-time bundle, we might want to ADD to existing scans instead of overwriting
    // For simplicity here, we'll overwrite as per typical "buy this bundle" logic
    // But we'll reset the usage counters
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
