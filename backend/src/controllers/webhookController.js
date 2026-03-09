const crypto = require("crypto");
const db = require("../db");

const { getByWhoopUserId } = require("../repositories/whoopConnectionRepo");
const {
  getWorkoutById,
  getSleepById,
  getRecoveryById,
} = require("../services/whoopApiService");

const {
  upsertWorkout,
  upsertSleep,
  upsertRecovery,
} = require("../repositories/whoopDataRepo");

const { getValidAccessTokenForWhoopUser } = require("../services/whoopTokenService");

// WHOOP headers
const SIG_HEADER = "x-whoop-signature";
const TS_HEADER = "x-whoop-signature-timestamp";

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyWhoopSignature({ clientSecret, timestamp, rawBody, providedSignature }) {
  if (!clientSecret || !timestamp || !rawBody || !providedSignature) return false;

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
  const hmac = crypto.createHmac("sha256", clientSecret).update(message).digest("base64");

  return timingSafeEqual(hmac, providedSignature);
}

async function saveWebhookEvent(event) {
  const traceId = event.trace_id || null;
  const whoopUserId = String(event.user_id || "");
  const type = event.type || null;
  const objectId = event.id
    ? String(event.id)
    : event.object_id
    ? String(event.object_id)
    : null;

  const sql = `
    insert into whoop_webhook_events (trace_id, whoop_user_id, type, object_id, payload, received_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict do nothing
  `;

  await db.query(sql, [traceId, whoopUserId, type, objectId, event]);
}

async function fetchAndUpsert({ accessToken, whoopUserId, type, objectId }) {
  console.log("fetchAndUpsert called with:", {
    whoopUserId,
    type,
    objectId,
  });

  if (!type || !objectId) return;

  if (type.startsWith("workout")) {
    console.log("Fetching workout by id:", objectId);

    const w = await getWorkoutById(accessToken, objectId);
    const obj = w?.record || w?.data || w;

    console.log("Fetched workout object id:", obj?.id);

    const id = String(obj?.id || objectId);

    await upsertWorkout({
      id,
      whoopUserId,
      startTime: obj?.start_time || obj?.start || null,
      endTime: obj?.end_time || obj?.end || null,
      raw: obj,
    });

    console.log("Upserted workout:", id);
    return;
  }

  if (type.startsWith("sleep")) {
    console.log("Fetching sleep by id:", objectId);

    const s = await getSleepById(accessToken, objectId);
    const obj = s?.record || s?.data || s;

    console.log("Fetched sleep object id:", obj?.id);

    const id = String(obj?.id || objectId);

    await upsertSleep({
      id,
      whoopUserId,
      startTime: obj?.start_time || obj?.start || null,
      endTime: obj?.end_time || obj?.end || null,
      raw: obj,
    });

    console.log("Upserted sleep:", id);
    return;
  }

  if (type.startsWith("recovery")) {
    console.log("Recovery webhook received. In v2 the webhook id is the associated sleep UUID:", objectId);

    // For now, fetch recovery by the same objectId only if your API/service supports it.
    // If this fails, we’ll switch to a sleep->cycle->recovery flow in Step 2.
    const r = await getRecoveryById(accessToken, objectId);
    const obj = r?.record || r?.data || r;

    console.log("Fetched recovery object id:", obj?.id);

    const id = String(obj?.id || objectId);

    await upsertRecovery({
      id,
      whoopUserId,
      cycleId: obj?.cycle_id ? String(obj.cycle_id) : null,
      raw: obj,
    });

    console.log("Upserted recovery:", id);
    return;
  }

  console.log("Webhook type not handled in fetchAndUpsert:", type);
}

exports.whoopWebhook = async (req, res) => {
  try {
    const providedSignature = req.headers[SIG_HEADER];
    const timestamp = req.headers[TS_HEADER];
    const rawBody = req.rawBody;

    const isManualTest = req.query?.test === "1" || req.body?.test === true;

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
    console.log("WHOOP webhook received:", JSON.stringify(event));

    await saveWebhookEvent(event);

    // Respond fast
    res.status(200).json({ ok: true });

    // Async follow-up
    try {
      const whoopUserId = String(event.user_id || "");
      const type = event.type || "";
      const objectId = event.id
        ? String(event.id)
        : event.object_id
        ? String(event.object_id)
        : null;

      if (!whoopUserId || !type || !objectId) {
        console.log("Webhook missing whoopUserId/type/objectId. Skipping follow-up.");
        return;
      }

      const conn = await getByWhoopUserId(whoopUserId);
      if (!conn) {
        console.log("No WHOOP connection found for whoop_user_id:", whoopUserId);
        return;
      }

      const accessToken = await getValidAccessTokenForWhoopUser(conn);

      await fetchAndUpsert({
        accessToken,
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