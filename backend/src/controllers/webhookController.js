const crypto = require("crypto");
const { getByWhoopUserId } = require("../repositories/whoopConnectionRepo");
const {
  getWorkoutById,
  getSleepById,
  getRecoveryById,
  getCycleById,
} = require("../services/whoopApiService");

const {
  upsertWorkout,
  upsertSleep,
  upsertRecovery,
  upsertCycle,
} = require("../repositories/whoopDataRepo");

const db = require("../db");

// WHOOP headers
const SIG_HEADER = "x-whoop-signature";
const TS_HEADER = "x-whoop-signature-timestamp";

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

async function saveWebhookEvent(event) {
  // store raw webhook in whoop_webhook_events
  const sql = `
    insert into whoop_webhook_events (trace_id, whoop_user_id, type, object_id, payload, received_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict do nothing
  `;
  const traceId = event.trace_id || null;
  const whoopUserId = String(event.user_id || "");
  const type = event.type || null;
  const objectId = event.id ? String(event.id) : (event.object_id ? String(event.object_id) : null);

  await db.query(sql, [traceId, whoopUserId, type, objectId, event]);
}

async function fetchAndUpsert({ accessToken, whoopUserId, type, objectId }) {
  if (!type || !objectId) return;

  // You may see types like:
  // workout.updated, sleep.updated, recovery.updated, cycle.updated
  if (type.startsWith("workout")) {
    const w = await getWorkoutById(accessToken, objectId);
    const obj = w?.record || w?.data || w;
    const id = String(obj.id || objectId);
    await upsertWorkout({
      id,
      whoopUserId,
      startTime: obj.start || obj.start_time || null,
      endTime: obj.end || obj.end_time || null,
      raw: obj,
    });
    return;
  }

  if (type.startsWith("sleep")) {
    const s = await getSleepById(accessToken, objectId);
    const obj = s?.record || s?.data || s;
    const id = String(obj.id || objectId);
    await upsertSleep({
      id,
      whoopUserId,
      startTime: obj.start || obj.start_time || null,
      endTime: obj.end || obj.end_time || null,
      raw: obj,
    });
    return;
  }

  if (type.startsWith("recovery")) {
    const r = await getRecoveryById(accessToken, objectId);
    const obj = r?.record || r?.data || r;
    const id = String(obj.id || objectId);
    await upsertRecovery({
      id,
      whoopUserId,
      cycleId: obj.cycle_id || null,
      raw: obj,
    });
    return;
  }

  if (type.startsWith("cycle")) {
    const c = await getCycleById(accessToken, objectId);
    const obj = c?.record || c?.data || c;
    const id = String(obj.id || objectId);
    await upsertCycle({
      id,
      whoopUserId,
      startTime: obj.start || obj.start_time || null,
      endTime: obj.end || obj.end_time || null,
      raw: obj,
    });
    return;
  }
}

exports.whoopWebhook = async (req, res) => {
  try {
    const providedSignature = req.headers[SIG_HEADER];
    const timestamp = req.headers[TS_HEADER];
    const rawBody = req.rawBody;

    const isManualTest = req.query?.test === "1" || req.body?.test === true;

    // Signature check (skip only for manual tests)
    if (!isManualTest) {
      const ok = verifyWhoopSignature({
        clientSecret: process.env.WHOOP_CLIENT_SECRET,
        timestamp,
        rawBody,
        providedSignature,
      });
      if (!ok) {
        return res.status(401).json({ ok: false, error: "Invalid WHOOP signature" });
      }
    }

    const event = req.body;
    await saveWebhookEvent(event);

    // ACK fast
    res.status(200).json({ ok: true });

    // Async follow-up (fetch full object and upsert)
    try {
      const whoopUserId = String(event.user_id || "");
      const type = event.type || "";
      const objectId = event.id ? String(event.id) : (event.object_id ? String(event.object_id) : null);
      if (!whoopUserId || !type || !objectId) return;

      const conn = await getByWhoopUserId(whoopUserId);
      if (!conn?.access_token) return;

      await fetchAndUpsert({
        accessToken: conn.access_token,
        whoopUserId,
        type,
        objectId,
      });
    } catch (e) {
      console.error("Webhook follow-up fetch failed:", e?.response?.data || e.message);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
};