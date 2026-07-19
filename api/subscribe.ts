import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { sendTelegramAlert } from "./_telegram.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";

const MONTHLY_PRICE = 149;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    console.warn("[/api/subscribe] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    console.log("Checking authentication...");
    const user = await getAuthedUser(req);
    if (!user) {
      console.warn("[/api/subscribe] Rejected — auth required");
      return res.status(401).json({ error: "auth_required" });
    }
    console.log("Authentication OK. userId:", user.id);

    const { plan, screenshotUrl } = req.body || {};
    if (plan !== "monthly") {
      console.warn("[/api/subscribe] Invalid plan:", plan);
      return res.status(400).json({ error: "invalid_plan" });
    }
    if (!screenshotUrl || typeof screenshotUrl !== "string") {
      console.warn("[/api/subscribe] Missing screenshotUrl");
      return res.status(400).json({ error: "missing_screenshot" });
    }

    const amount = MONTHLY_PRICE;
    const admin = getSupabaseAdmin();

    // Always created as pending_review — activation happens ONLY via admin
    // approval (Section 15). This endpoint never grants Premium itself.
    console.log("Saving database...");
    const { data, error } = await admin
      .from("subscription_requests")
      .insert({
        user_id: user.id,
        plan,
        amount,
        screenshot_url: screenshotUrl,
        status: "pending_review",
      })
      .select()
      .single();

    if (error || !data) {
      console.error("[/api/subscribe] insert failed:", error);
      return res.status(500).json({ error: "server_error" });
    }
    console.log("Saving database... done. requestId:", data.id);

    await sendTelegramAlert(
      `💰 <b>New subscription request</b>\nUser: ${user.email}\nPlan: ${plan}\nAmount: ${amount} EGP\nScreenshot: ${screenshotUrl}`
    );

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({ success: true, requestId: data.id });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
