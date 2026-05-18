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
 * Reads latest stored sleep/recovery/cycle rows from DB and returns raw payloads.
 */
exports.getSummary = async (req, res) => {
  try {
    const appUserId = (req.query.app_user_id || "").trim();
    if (!appUserId) {
      return res.status(400).json({ ok: false, error: "Missing app_user_id" });
    }

    const conn = await getByAppUserId(appUserId);
    if (!conn) {
      return res.status(404).json({ ok: false, error: "No WHOOP connection" });
    }

    const whoopUserId = String(conn.whoop_user_id);

    const [recoveryRes, sleepRes, cycleRes] = await Promise.all([
      db.query(
        `
        select raw, updated_at
        from whoop_recoveries
        where whoop_user_id = $1
        order by updated_at desc
        limit 1
        `,
        [whoopUserId]
      ),
      db.query(
        `
        select raw, updated_at
        from whoop_sleeps
        where whoop_user_id = $1
        order by updated_at desc
        limit 1
        `,
        [whoopUserId]
      ),
      db.query(
        `
        select raw, updated_at
        from whoop_cycles
        where whoop_user_id = $1
        order by updated_at desc
        limit 1
        `,
        [whoopUserId]
      ),
    ]);

    const recovery = recoveryRes.rows[0]?.raw || null;
    const sleep = sleepRes.rows[0]?.raw || null;
    const cycle = cycleRes.rows[0]?.raw || null;

    return res.json({
      ok: true,
      app_user_id: appUserId,
      whoop_user_id: whoopUserId,
      recovery,
      sleep,
      cycle,
      updated_at:
        recoveryRes.rows[0]?.updated_at ||
        sleepRes.rows[0]?.updated_at ||
        cycleRes.rows[0]?.updated_at ||
        null,
    });
  } catch (err) {
    console.error("SUMMARY error:", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
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
