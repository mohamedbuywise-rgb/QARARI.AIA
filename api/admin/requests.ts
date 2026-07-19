import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "../_logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  try {
    console.log("Checking authentication...");
    if (!isValidAdmin(req)) {
      console.warn("[/api/admin/requests] Rejected — invalid admin credentials");
      return res.status(401).json({ error: "unauthorized" });
    }
    console.log("Authentication OK");

    const admin = getSupabaseAdmin();

    console.log("Loading pending subscription requests...");
    const { data, error } = await admin
      .from("subscription_requests")
      .select("*, users(email, full_name)")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[/api/admin/requests] Supabase select failed:", error);
      return res.status(500).json({ error: "server_error" });
    }
    console.log("[/api/admin/requests] Loaded", (data || []).length, "pending requests");

    // The "screenshots" bucket is private, so generate a short-lived signed URL
    // for each request's screenshot rather than exposing a permanent public link.
    console.log("Generating signed screenshot URLs...");
    const withSignedUrls = await Promise.all(
      (data || []).map(async (r: any) => {
        try {
          const { data: signed, error: signErr } = await admin.storage.from("screenshots").createSignedUrl(r.screenshot_url, 3600);
          if (signErr) {
            console.error(`[/api/admin/requests] Failed to sign screenshot for request ${r.id}:`, signErr);
          }
          return { ...r, screenshot_signed_url: signed?.signedUrl || null };
        } catch (e: any) {
          console.error(`[/api/admin/requests] Signing threw for request ${r.id}:`, e, e?.stack);
          return { ...r, screenshot_signed_url: null };
        }
      })
    );

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({ requests: withSignedUrls });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
