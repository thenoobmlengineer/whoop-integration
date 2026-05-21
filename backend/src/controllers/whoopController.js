// src/controllers/whoopController.js
const db = require("../db");
const { getByAppUserId, deleteByAppUserId } = require("../repositories/whoopConnectionRepo");
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
  return obj?.start_time || obj?.start || obj?.start_at || obj?.start_datetime || null;
}

function getEnd(obj) {
  return obj?.end_time || obj?.end || obj?.end_at || obj?.end_datetime || null;
}

/**
 * POST /whoop/backfill?app_user_id=USER123&days=30
 * Production default: 30 days
 */
exports.backfill = async (req, res) => {
  try {
    const appUserId = (req.query.app_user_id || "").trim();
    if (!appUserId) {
      return res.status(400).json({ ok: false, error: "Missing app_user_id" });
    }

    let days = parseInt(req.query.days || "30", 10);
    if (Number.isNaN(days)) days = 30;
    if (days < 1) days = 1;
    if (days > 30) days = 30;

    const conn = await getByAppUserId(appUserId);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "No WHOOP connection" });
    }

    const accessToken = await getValidAccessTokenForAppUser(conn);
    const whoopUserId = conn.whoop_user_id;

    const startTime = isoDaysAgo(days);
    const endTime = new Date().toISOString();

    const params = {
      start: startTime,
      end: endTime,
      start_time: startTime,
      end_time: endTime,
      limit: 25,
    };

    console.log("BACKFILL params:", {
      appUserId,
      whoopUserId,
      startTime,
      endTime,
      params,
    });

    const [workoutsResp, sleepsResp, recoveriesResp, cyclesResp] = await Promise.all([
      getWorkouts(accessToken, params),
      getSleeps(accessToken, params),
      getRecoveries(accessToken, params),
      getCycles(accessToken, params),
    ]);

    console.log("BACKFILL workoutsResp raw:", JSON.stringify(workoutsResp));
    console.log("BACKFILL sleepsResp raw:", JSON.stringify(sleepsResp));
    console.log("BACKFILL recoveriesResp raw:", JSON.stringify(recoveriesResp));
    console.log("BACKFILL cyclesResp raw:", JSON.stringify(cyclesResp));

    const workoutItems = toItems(workoutsResp);
    const sleepItems = toItems(sleepsResp);
    const recoveryItems = toItems(recoveriesResp);
    const cycleItems = toItems(cyclesResp);

    console.log("BACKFILL workoutItems count:", workoutItems.length);
    console.log("BACKFILL sleepItems count:", sleepItems.length);
    console.log("BACKFILL recoveryItems count:", recoveryItems.length);
    console.log("BACKFILL cycleItems count:", cycleItems.length);

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
        console.log("Skipping recovery row because no id/cycle_id/sleep_id:", JSON.stringify(r));
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
    console.error("BACKFILL error:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

/**
 * GET /whoop/summary?app_user_id=USER123
 * Returns a cycle-consistent WHOOP summary:
 * selected cycle + recovery for same cycle + sleep for same cycle.
 */
exports.getSummary = async (req, res) => {
  try {
    const appUserId = String(req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({ ok: false, error: "Missing app_user_id" });
    }

    const conn = await getByAppUserId(appUserId);

    if (!conn) {
      return res.status(404).json({ ok: false, error: "No WHOOP connection" });
    }

    const whoopUserId = String(conn.whoop_user_id);

    /**
     * 1) Pick the latest WHOOP cycle by actual cycle start time,
     * not by DB updated_at.
     *
     * This avoids selecting an older cycle just because it was updated during backfill.
     */
    const cycleRes = await db.query(
      `
      select id, raw, start_time, end_time, updated_at
      from whoop_cycles
      where whoop_user_id = $1
      order by
        start_time desc nulls last,
        updated_at desc
      limit 1
      `,
      [whoopUserId]
    );

    const cycleRow = cycleRes.rows[0] || null;
    const cycle = cycleRow?.raw || null;

    const selectedCycleId = cycleRow?.id
      ? String(cycleRow.id)
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

    /**
     * 2) Find recovery for the selected cycle.
     *
     * Your table already has cycle_id because upsertRecovery stores it.
     */
    const recoveryRes = await db.query(
      `
      select id, cycle_id, sleep_id, raw, updated_at
      from whoop_recoveries
      where whoop_user_id = $1
        and cycle_id = $2
      order by updated_at desc
      limit 1
      `,
      [whoopUserId, selectedCycleId]
    );

    const recoveryRow = recoveryRes.rows[0] || null;
    const recovery = recoveryRow?.raw || null;

    /**
     * 3) Find sleep for the same cycle.
     *
     * Your whoop_sleeps table does not currently store cycle_id as a separate column,
     * so we read it from raw->>'cycle_id'.
     */
    const sleepRes = await db.query(
      `
      select id, raw, start_time, end_time, updated_at
      from whoop_sleeps
      where whoop_user_id = $1
        and raw->>'cycle_id' = $2
      order by
        start_time desc nulls last,
        updated_at desc
      limit 1
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

      updated_at:
        recoveryRow?.updated_at ||
        sleepRow?.updated_at ||
        cycleRow?.updated_at ||
        conn.updated_at ||
        null,

      debug: {
        selected_cycle_id: selectedCycleId,
        cycle_row_id: cycleRow?.id ? String(cycleRow.id) : null,
        cycle_start_time: cycleRow?.start_time || cycle?.start || cycle?.start_time || null,
        cycle_end_time: cycleRow?.end_time || cycle?.end || cycle?.end_time || null,

        recovery_found: !!recovery,
        recovery_row_id: recoveryRow?.id ? String(recoveryRow.id) : null,
        recovery_cycle_id: recoveryRow?.cycle_id ? String(recoveryRow.cycle_id) : null,
        recovery_sleep_id: recoveryRow?.sleep_id ? String(recoveryRow.sleep_id) : null,

        sleep_found: !!sleep,
        sleep_row_id: sleepRow?.id ? String(sleepRow.id) : null,
        sleep_cycle_id: sleep?.cycle_id ? String(sleep.cycle_id) : null,

        cycle_score_state: cycle?.score_state || null,
        recovery_score_state: recovery?.score_state || null,
        sleep_score_state: sleep?.score_state || null,
      },
    });
  } catch (err) {
    console.error("SUMMARY error:", err?.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to fetch WHOOP summary",
    });
  }
};

/**
 * POST /whoop/disconnect?app_user_id=USER123
 * Removes stored WHOOP OAuth connection for this app user.
 */
exports.disconnect = async (req, res) => {
  try {
    const appUserId = (req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing app_user_id",
      });
    }

    const deleted = await deleteByAppUserId(appUserId);

    return res.json({
      ok: true,
      connected: false,
      app_user_id: appUserId,
      whoop_user_id: deleted?.whoop_user_id || null,
      disconnected: !!deleted,
    });
  } catch (err) {
    console.error("WHOOP disconnect error:", err?.message || err);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to disconnect WHOOP",
    });
  }
};
