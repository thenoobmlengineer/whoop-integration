const { getByAppUserId } = require("../repositories/whoopConnectionRepo");
const { getSleeps, getWorkouts, getRecoveries, getCycles } = require("../services/whoopApiService");
const { upsertWorkout, upsertSleep, upsertRecovery, upsertCycle } = require("../repositories/whoopDataRepo");

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

exports.backfill = async (req, res) => {
  try {
    const appUserId = (req.query.app_user_id || "").trim();
    const days = Math.min(parseInt(req.query.days || "30", 10), 365);

    if (!appUserId) return res.status(400).json({ ok: false, error: "Missing app_user_id" });

    const conn = await getByAppUserId(appUserId);
    if (!conn) return res.status(404).json({ ok: false, error: "No WHOOP connection" });

    const accessToken = conn.access_token;
    const whoopUserId = conn.whoop_user_id;

    const start = isoDaysAgo(days);
    const end = new Date().toISOString();

    // Fetch collections (pagination may be needed later)
    const [workouts, sleeps, recoveries, cycles] = await Promise.all([
      getWorkouts(accessToken, { start, end }),
      getSleeps(accessToken, { start, end }),
      getRecoveries(accessToken, { start, end }),
      getCycles(accessToken, { start, end }),
    ]);

    // The response shape can be { records: [] } or { data: [] } depending on WHOOP
    const workoutItems = workouts?.records || workouts?.data || workouts || [];
    const sleepItems = sleeps?.records || sleeps?.data || sleeps || [];
    const recoveryItems = recoveries?.records || recoveries?.data || recoveries || [];
    const cycleItems = cycles?.records || cycles?.data || cycles || [];

    // Upsert into DB
    for (const w of workoutItems) {
      const id = String(w.id || w.workout_id || w.uuid);
      if (!id) continue;
      await upsertWorkout({
        id,
        whoopUserId,
        startTime: w.start || w.start_time || null,
        endTime: w.end || w.end_time || null,
        raw: w,
      });
    }

    for (const s of sleepItems) {
      const id = String(s.id || s.sleep_id || s.uuid);
      if (!id) continue;
      await upsertSleep({
        id,
        whoopUserId,
        startTime: s.start || s.start_time || null,
        endTime: s.end || s.end_time || null,
        raw: s,
      });
    }

    for (const r of recoveryItems) {
      const id = String(r.id || r.recovery_id || r.uuid);
      if (!id) continue;
      await upsertRecovery({
        id,
        whoopUserId,
        cycleId: r.cycle_id || null,
        raw: r,
      });
    }

    for (const c of cycleItems) {
      const id = String(c.id || c.cycle_id || c.uuid);
      if (!id) continue;
      await upsertCycle({
        id,
        whoopUserId,
        startTime: c.start || c.start_time || null,
        endTime: c.end || c.end_time || null,
        raw: c,
      });
    }

    return res.json({
      ok: true,
      backfilled_days: days,
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