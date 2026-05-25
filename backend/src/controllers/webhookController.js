// src/controllers/webhookController.js
const crypto = require("crypto");
const db = require("../db");
const { table } = require("../db/schema");

const { getByWhoopUserId } = require("../repositories/whoopConnectionRepo");
const {
  getWorkoutById,
  getSleepById,
  getRecoveries,
  getCycles,
} = require("../services/whoopApiService");

const {
  upsertWorkout,
  upsertSleep,
  upsertRecovery,
  upsertCycle,
} = require("../repositories/whoopDataRepo");

const { getValidAccessTokenForWhoopUser } = require("../services/whoopTokenService");

// WHOOP webhook headers
const SIG_HEADER = "x-whoop-signature";
const TS_HEADER = "x-whoop-signature-timestamp";

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");

  if (aBuf.length !== bBuf.length) return false;

  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyWhoopSignature({
  clientSecret,
  timestamp,
  rawBody,
  providedSignature,
}) {
  if (!clientSecret || !timestamp || !rawBody || !providedSignature) {
    return false;
  }

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);

  const expectedSignature = crypto
    .createHmac("sha256", clientSecret)
    .update(message)
    .digest("base64");

  return timingSafeEqual(expectedSignature, providedSignature);
}

function makeWebhookEventId(event) {
  const raw = [
    event.trace_id || "",
    event.user_id || "",
    event.type || "",
    event.id || event.object_id || "",
  ].join(":");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

/**
 * Saves webhook event to AWS schema.
 *
 * Important:
 * This is non-critical logging. If the table does not exist yet,
 * the webhook should still continue and sync WHOOP data.
 */
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
    INSERT INTO ${table("WhoopWebhookEvent")} (
      id,
      "traceId",
      "whoopUserId",
      type,
      "objectId",
      payload,
      "receivedAt"
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
    ON CONFLICT (id) DO NOTHING
  `;

  try {
    await db.query(sql, [
      makeWebhookEventId(event),
      traceId,
      whoopUserId,
      type,
      objectId,
      JSON.stringify(event),
    ]);
  } catch (err) {
    // 42P01 = undefined_table
    // We do not fail the webhook if optional logging table is missing.
    console.warn("WHOOP webhook event log skipped:", err.message);
  }
}

function toItems(resp) {
  return resp?.records || resp?.data || resp?.items || resp || [];
}

function getId(obj, fallback) {
  return String(
    obj?.id ||
      obj?.workout_id ||
      obj?.sleep_id ||
      obj?.cycle_id ||
      obj?.recovery_id ||
      obj?.uuid ||
      fallback ||
      ""
  );
}

function getStart(obj) {
  return (
    obj?.start_time ||
    obj?.start ||
    obj?.start_at ||
    obj?.start_datetime ||
    null
  );
}

function getEnd(obj) {
  return obj?.end_time || obj?.end || obj?.end_at || obj?.end_datetime || null;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * WHOOP does not send cycle webhooks.
 *
 * For recovery.updated in WHOOP v2, the webhook id can be the associated
 * sleep UUID rather than a recovery id. So for recovery freshness we sync
 * recent recoveries and cycles.
 */
async function syncRecentRecoveriesAndCycles({
  accessToken,
  whoopUserId,
  hours = 48,
}) {
  const startTime = isoHoursAgo(hours);
  const endTime = new Date().toISOString();

  const params = {
    start: startTime,
    end: endTime,
    start_time: startTime,
    end_time: endTime,
    limit: 25,
  };

  console.log("Running recent WHOOP recovery/cycle sync:", {
    whoopUserId,
    startTime,
    endTime,
  });

  const [recoveriesResp, cyclesResp] = await Promise.all([
    getRecoveries(accessToken, params),
    getCycles(accessToken, params),
  ]);

  const recoveryItems = toItems(recoveriesResp);
  const cycleItems = toItems(cyclesResp);

  console.log("Recent WHOOP sync counts:", {
    recoveries: recoveryItems.length,
    cycles: cycleItems.length,
  });

  for (const r of recoveryItems) {
    const cycleId = r?.cycle_id ? String(r.cycle_id) : null;
    const sleepId = r?.sleep_id ? String(r.sleep_id) : null;

    const id = cycleId || sleepId || getId(r);

    if (!id) {
      console.log(
        "Skipping recovery row because no id/cycle_id/sleep_id:",
        JSON.stringify(r)
      );
      continue;
    }

    await upsertRecovery({
      id,
      whoopUserId,
      cycleId,
      sleepId,
      raw: r,
    });
  }

  for (const c of cycleItems) {
    const id = getId(c);

    if (!id) {
      console.log("Skipping cycle row because no id:", JSON.stringify(c));
      continue;
    }

    await upsertCycle({
      id,
      whoopUserId,
      startTime: getStart(c),
      endTime: getEnd(c),
      raw: c,
    });
  }

  console.log("Recent WHOOP recovery/cycle sync complete:", {
    whoopUserId,
    recoveries: recoveryItems.length,
    cycles: cycleItems.length,
  });
}

async function fetchAndUpsert({ accessToken, whoopUserId, type, objectId }) {
  console.log("WHOOP fetchAndUpsert:", {
    whoopUserId,
    type,
    objectId,
  });

  if (!type || !objectId) return;

  if (type.startsWith("workout")) {
    const workoutResp = await getWorkoutById(accessToken, objectId);
    const workout = workoutResp?.record || workoutResp?.data || workoutResp;

    const id = String(workout?.id || objectId);

    await upsertWorkout({
      id,
      whoopUserId,
      startTime: getStart(workout),
      endTime: getEnd(workout),
      raw: workout,
    });

    console.log("WHOOP workout upserted:", id);
    return;
  }

  if (type.startsWith("sleep")) {
    const sleepResp = await getSleepById(accessToken, objectId);
    const sleep = sleepResp?.record || sleepResp?.data || sleepResp;

    const id = String(sleep?.id || objectId);

    await upsertSleep({
      id,
      whoopUserId,
      startTime: getStart(sleep),
      endTime: getEnd(sleep),
      raw: sleep,
    });

    console.log("WHOOP sleep upserted:", id);
    return;
  }

  if (type.startsWith("recovery")) {
    console.log(
      "WHOOP recovery webhook received. Running recent recovery/cycle sync:",
      objectId
    );

    await syncRecentRecoveriesAndCycles({
      accessToken,
      whoopUserId,
      hours: 48,
    });

    return;
  }

  console.log("WHOOP webhook type not handled:", type);
}

exports.whoopWebhook = async (req, res) => {
  try {
    const providedSignature = req.headers[SIG_HEADER];
    const timestamp = req.headers[TS_HEADER];
    const rawBody = req.rawBody;

    const isManualTest = req.query?.test === "1" || req.body?.test === true;

    if (!isManualTest) {
      const isValidSignature = verifyWhoopSignature({
        clientSecret: process.env.WHOOP_CLIENT_SECRET,
        timestamp,
        rawBody,
        providedSignature,
      });

      if (!isValidSignature) {
        return res.status(401).json({
          ok: false,
          error: "Invalid WHOOP signature",
        });
      }
    }

    const event = req.body;

    console.log("WHOOP webhook received:", JSON.stringify(event));

    await saveWebhookEvent(event);

    // ACK quickly so WHOOP does not retry because of slow processing.
    res.status(200).json({ ok: true });

    // Continue processing after ACK.
    try {
      const whoopUserId = String(event.user_id || "");
      const type = event.type || "";

      const objectId = event.id
        ? String(event.id)
        : event.object_id
        ? String(event.object_id)
        : null;

      if (!whoopUserId || !type || !objectId) {
        console.log(
          "WHOOP webhook missing whoopUserId/type/objectId. Skipping follow-up."
        );
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
    } catch (err) {
      console.error(
        "WHOOP webhook follow-up fetch failed:",
        err?.response?.data || err.message
      );
    }
  } catch (err) {
    console.error("WHOOP webhook error:", err);

    return res.status(500).json({
      ok: false,
      error: "Server error",
    });
  }
};