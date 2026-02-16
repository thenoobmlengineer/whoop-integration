const crypto = require("crypto");

// WHOOP headers (per docs)
const SIG_HEADER = "x-whoop-signature";
const TS_HEADER = "x-whoop-signature-timestamp";

// timing safe compare
function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * WHOOP signature verification (HMAC SHA256, base64)
 * message = timestamp + rawBody
 * signature = base64(hmac_sha256(client_secret, message))
 */
function verifyWhoopSignature({ clientSecret, timestamp, rawBody, providedSignature }) {
  if (!clientSecret || !timestamp || !rawBody || !providedSignature) return false;

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  const hmac = crypto.createHmac("sha256", clientSecret).update(message).digest("base64");
  return timingSafeEqual(hmac, providedSignature);
}

exports.whoopWebhook = async (req, res) => {
  try {
    const providedSignature = req.headers[SIG_HEADER];
    const timestamp = req.headers[TS_HEADER];

    // rawBody is added by express verify function (we’ll add in index.js below)
    const rawBody = req.rawBody;

    const ok = verifyWhoopSignature({
      clientSecret: process.env.WHOOP_CLIENT_SECRET,
      timestamp,
      rawBody,
      providedSignature,
    });

    if (!ok) {
      return res.status(401).json({ ok: false, error: "Invalid WHOOP signature" });
    }

    // At this point webhook is authentic.
    // The payload usually contains: user_id, type, id, trace_id
    // Example events: sleep.updated, workout.updated, recovery.updated, etc.
    const event = req.body;

    // IMPORTANT: ACK fast. Do heavy work async (queue/worker) later.
    // For now we just log it.
    console.log("WHOOP webhook event:", JSON.stringify(event));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};
