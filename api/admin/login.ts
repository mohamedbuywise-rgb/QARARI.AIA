import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./_auth.js";
import { logRequestStart, logRequestSuccess } from "../_logger.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    console.warn("[/api/admin/login] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  console.log("Checking authentication...");
  if (!isValidAdmin(req)) {
    console.warn("[/api/admin/login] Invalid credentials");
    return res.status(401).json({ error: "invalid_credentials" });
  }
  console.log("Authentication OK");

  console.log("Returning response...");
  logRequestSuccess(start);
  return res.status(200).json({ success: true });
}
