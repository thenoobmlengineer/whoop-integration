const { getByAppUserId } = require("../repositories/whoopConnectionRepo");
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
      limit: 100,
    };

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

    for (const w of workoutItems) {
      const id = getId(w);
      if (!id) continue;

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
      if (!id) continue;

      await upsertSleep({
        id,
        whoopUserId,
        startTime: getStart(s),
        endTime: getEnd(s),
        raw: s,
      });
    }

    for (const r of recoveryItems) {
      const id = getId(r);
      if (!id) continue;

      await upsertRecovery({
        id,
        whoopUserId,
        cycleId: r?.cycle_id ? String(r.cycle_id) : null,
        raw: r,
      });
    }

    for (const c of cycleItems) {
      const id = getId(c);
      if (!id) continue;

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
    return res.status(500).json({ ok: false, error: err.message });
  }
};