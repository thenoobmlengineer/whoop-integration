// src/controllers/whoopController.js
const db = require("../db");
const { table } = require("../db/schema");

const {
  getByAppUserId,
  deleteByAppUserId,
} = require("../repositories/whoopConnectionRepo");

const {
  getSleeps,
  getWorkouts,
  getRecoveries,
  getCycles,
} = require("../services/whoopApiService");

const {
  upsertWorkout,
  upsertSleep,
  upsertRecovery,
  upsertCycle,
} = require("../repositories/whoopDataRepo");

const { getValidAccessTokenForAppUser } = require("../services/whoopTokenService");

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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

/**
 * POST /whoop/backfill?app_user_id=USER123&days=30
 *
 * Fetches WHOOP data from API and saves it into AWS tables:
 * - zeam_platform.WhoopWorkout
 * - zeam_platform.WhoopSleep
 * - zeam_platform.WhoopRecovery
 * - zeam_platform.WhoopCycle
 */
exports.backfill = async (req, res) => {
  try {
    const appUserId = String(req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing app_user_id",
      });
    }

    let days = parseInt(req.query.days || "30", 10);

    if (Number.isNaN(days)) days = 30;
    if (days < 1) days = 1;
    if (days > 30) days = 30;

    const conn = await getByAppUserId(appUserId);

    if (!conn) {
      return res.status(404).json({
        ok: false,
        error: "No WHOOP connection",
      });
    }

    const accessToken = await getValidAccessTokenForAppUser(conn);
    const whoopUserId = String(conn.whoop_user_id);

    const startTime = isoDaysAgo(days);
    const endTime = new Date().toISOString();

    const params = {
      start: startTime,
      end: endTime,
      start_time: startTime,
      end_time: endTime,
      limit: 25,
    };

    console.log("WHOOP BACKFILL params:", {
      appUserId,
      whoopUserId,
      startTime,
      endTime,
      days,
    });

    const [workoutsResp, sleepsResp, recoveriesResp, cyclesResp] =
      await Promise.all([
        getWorkouts(accessToken, params),
        getSleeps(accessToken, params),
        getRecoveries(accessToken, params),
        getCycles(accessToken, params),
      ]);

    const workoutItems = toItems(workoutsResp);
    const sleepItems = toItems(sleepsResp);
    const recoveryItems = toItems(recoveriesResp);
    const cycleItems = toItems(cyclesResp);

    console.log("WHOOP BACKFILL counts:", {
      workouts: workoutItems.length,
      sleeps: sleepItems.length,
      recoveries: recoveryItems.length,
      cycles: cycleItems.length,
    });

    for (const w of workoutItems) {
      const id = getId(w);

      if (!id) {
        console.log("Skipping workout row because no id:", JSON.stringify(w));
        continue;
      }

      await upsertWorkout({
        id,
        whoopUserId,
        startTime: getStart(w),
        endTime: getEnd(w),
        raw: w,
      });
    }

    for (const s of sleepItems) {
      const id = getId(s);

      if (!id) {
        console.log("Skipping sleep row because no id:", JSON.stringify(s));
        continue;
      }

      await upsertSleep({
        id,
        whoopUserId,
        startTime: getStart(s),
        endTime: getEnd(s),
        raw: s,
      });
    }

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

    return res.json({
      ok: true,
      backfilled_days: days,
      range: {
        start_time: startTime,
        end_time: endTime,
      },
      counts: {
        workouts: workoutItems.length,
        sleeps: sleepItems.length,
        recoveries: recoveryItems.length,
        cycles: cycleItems.length,
      },
    });
  } catch (err) {
    console.error("WHOOP BACKFILL error:", err?.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to backfill WHOOP data",
      details: err?.response?.data || null,
    });
  }
};

/**
 * GET /whoop/summary?app_user_id=USER123
 *
 * Reads migrated AWS WHOOP data and returns:
 * - latest cycle
 * - recovery for same cycle
 * - sleep for same cycle
 */
exports.getSummary = async (req, res) => {
  try {
    const appUserId = String(req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing app_user_id",
      });
    }

    const conn = await getByAppUserId(appUserId);

    if (!conn) {
      return res.status(404).json({
        ok: false,
        error: "No WHOOP connection",
      });
    }

    const whoopUserId = String(conn.whoop_user_id);

    const cycleRes = await db.query(
      `
      SELECT
        wc.id,
        wc."externalId",
        wc."rawPayload" AS raw,
        wc.start AS start_time,
        wc."end" AS end_time,
        wc.strain,
        wc.kilojoule,
        wc."updatedAt" AS updated_at
      FROM ${table("WhoopCycle")} wc
      JOIN ${table("PatientDeviceConnection")} pdc
        ON pdc.id = wc."connectionId"
      WHERE pdc."externalUserId" = $1
        AND pdc.type = 'WHOOP'
        AND pdc."archivedAt" IS NULL
      ORDER BY
        wc.start DESC NULLS LAST,
        wc."updatedAt" DESC
      LIMIT 1
      `,
      [whoopUserId]
    );

    const cycleRow = cycleRes.rows[0] || null;
    const cycle = cycleRow?.raw || null;

    const selectedCycleId = cycleRow?.externalId
      ? String(cycleRow.externalId)
      : cycle?.id
      ? String(cycle.id)
      : cycle?.cycle_id
      ? String(cycle.cycle_id)
      : null;

    if (!selectedCycleId) {
      return res.json({
        ok: true,
        app_user_id: appUserId,
        whoop_user_id: whoopUserId,
        recovery: null,
        sleep: null,
        cycle: null,
        updated_at: conn.updated_at || null,
        debug: {
          reason: "No WHOOP cycle found for this user.",
        },
      });
    }

    const recoveryRes = await db.query(
      `
      SELECT
        wr.id,
        wr."externalId",
        wr."rawPayload" AS raw,
        wr.score,
        wr."restingHeartRate",
        wr."hrvRmssdMs",
        wr."respiratoryRate",
        wr."spo2Percent",
        wr."skinTempCelsius",
        wr."createdAtWhoop",
        wr."updatedAt" AS updated_at
      FROM ${table("WhoopRecovery")} wr
      JOIN ${table("PatientDeviceConnection")} pdc
        ON pdc.id = wr."connectionId"
      WHERE pdc."externalUserId" = $1
        AND pdc.type = 'WHOOP'
        AND pdc."archivedAt" IS NULL
        AND (
          wr."externalId" = $2
          OR wr."rawPayload"->>'cycle_id' = $2
        )
      ORDER BY
        wr."createdAtWhoop" DESC NULLS LAST,
        wr."updatedAt" DESC
      LIMIT 1
      `,
      [whoopUserId, selectedCycleId]
    );

    const recoveryRow = recoveryRes.rows[0] || null;
    const recovery = recoveryRow?.raw || null;

    const sleepRes = await db.query(
      `
      SELECT
        ws.id,
        ws."externalId",
        ws."rawPayload" AS raw,
        ws.start AS start_time,
        ws."end" AS end_time,
        ws."totalSleepMs",
        ws."sleepEfficiency",
        ws."sleepPerformance",
        ws."remMs",
        ws."slowWaveMs",
        ws."lightMs",
        ws."wakeMs",
        ws."updatedAt" AS updated_at
      FROM ${table("WhoopSleep")} ws
      JOIN ${table("PatientDeviceConnection")} pdc
        ON pdc.id = ws."connectionId"
      WHERE pdc."externalUserId" = $1
        AND pdc.type = 'WHOOP'
        AND pdc."archivedAt" IS NULL
        AND ws."rawPayload"->>'cycle_id' = $2
      ORDER BY
        ws.start DESC NULLS LAST,
        ws."updatedAt" DESC
      LIMIT 1
      `,
      [whoopUserId, selectedCycleId]
    );

    const sleepRow = sleepRes.rows[0] || null;
    const sleep = sleepRow?.raw || null;

    return res.json({
      ok: true,
      app_user_id: appUserId,
      whoop_user_id: whoopUserId,

      recovery,
      sleep,
      cycle,

      normalized: {
        cycle: cycleRow
          ? {
              external_id: cycleRow.externalId,
              start_time: cycleRow.start_time,
              end_time: cycleRow.end_time,
              strain: cycleRow.strain,
              kilojoule: cycleRow.kilojoule,
            }
          : null,
        recovery: recoveryRow
          ? {
              external_id: recoveryRow.externalId,
              score: recoveryRow.score,
              resting_heart_rate: recoveryRow.restingHeartRate,
              hrv_rmssd_ms: recoveryRow.hrvRmssdMs,
              respiratory_rate: recoveryRow.respiratoryRate,
              spo2_percent: recoveryRow.spo2Percent,
              skin_temp_celsius: recoveryRow.skinTempCelsius,
              created_at_whoop: recoveryRow.createdAtWhoop,
            }
          : null,
        sleep: sleepRow
          ? {
              external_id: sleepRow.externalId,
              start_time: sleepRow.start_time,
              end_time: sleepRow.end_time,
              total_sleep_ms: sleepRow.totalSleepMs,
              sleep_efficiency: sleepRow.sleepEfficiency,
              sleep_performance: sleepRow.sleepPerformance,
              rem_ms: sleepRow.remMs,
              deep_sleep_ms: sleepRow.slowWaveMs,
              light_sleep_ms: sleepRow.lightMs,
              awake_ms: sleepRow.wakeMs,
            }
          : null,
      },

      updated_at:
        recoveryRow?.updated_at ||
        sleepRow?.updated_at ||
        cycleRow?.updated_at ||
        conn.updated_at ||
        null,

      debug: {
        selected_cycle_id: selectedCycleId,

        cycle_found: !!cycle,
        cycle_row_id: cycleRow?.id ? String(cycleRow.id) : null,
        cycle_external_id: cycleRow?.externalId
          ? String(cycleRow.externalId)
          : null,
        cycle_start_time:
          cycleRow?.start_time || cycle?.start || cycle?.start_time || null,
        cycle_end_time:
          cycleRow?.end_time || cycle?.end || cycle?.end_time || null,

        recovery_found: !!recovery,
        recovery_row_id: recoveryRow?.id ? String(recoveryRow.id) : null,
        recovery_external_id: recoveryRow?.externalId
          ? String(recoveryRow.externalId)
          : null,
        recovery_cycle_id: recovery?.cycle_id ? String(recovery.cycle_id) : null,
        recovery_sleep_id: recovery?.sleep_id ? String(recovery.sleep_id) : null,

        sleep_found: !!sleep,
        sleep_row_id: sleepRow?.id ? String(sleepRow.id) : null,
        sleep_external_id: sleepRow?.externalId
          ? String(sleepRow.externalId)
          : null,
        sleep_cycle_id: sleep?.cycle_id ? String(sleep.cycle_id) : null,

        cycle_score_state: cycle?.score_state || null,
        recovery_score_state: recovery?.score_state || null,
        sleep_score_state: sleep?.score_state || null,
      },
    });
  } catch (err) {
    console.error("WHOOP SUMMARY error:", err?.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to fetch WHOOP summary",
      details: err?.response?.data || null,
    });
  }
};

/**
 * POST /whoop/disconnect?app_user_id=USER123
 *
 * Marks WHOOP connection as disconnected in AWS.
 * Does not delete historical WHOOP data.
 */
exports.disconnect = async (req, res) => {
  try {
    const appUserId = String(req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing app_user_id",
      });
    }

    const disconnected = await deleteByAppUserId(appUserId);

    return res.json({
      ok: true,
      connected: false,
      app_user_id: appUserId,
      whoop_user_id: disconnected?.whoop_user_id || null,
      disconnected: !!disconnected,
    });
  } catch (err) {
    console.error("WHOOP disconnect error:", err?.message || err);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to disconnect WHOOP",
    });
  }
};