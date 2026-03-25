const db = require("../db");

async function upsertWorkout({ id, whoopUserId, startTime, endTime, raw }) {
  const sql = `
    insert into whoop_workouts (id, whoop_user_id, start_time, end_time, raw, updated_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict (id)
    do update set
      whoop_user_id = excluded.whoop_user_id,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      raw = excluded.raw,
      updated_at = now();
  `;
  await db.query(sql, [id, whoopUserId, startTime, endTime, raw]);
}

async function upsertSleep({ id, whoopUserId, startTime, endTime, raw }) {
  const sql = `
    insert into whoop_sleeps (id, whoop_user_id, start_time, end_time, raw, updated_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict (id)
    do update set
      whoop_user_id = excluded.whoop_user_id,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      raw = excluded.raw,
      updated_at = now();
  `;
  await db.query(sql, [id, whoopUserId, startTime, endTime, raw]);
}

async function upsertRecovery({ id, whoopUserId, cycleId, sleepId, raw }) {
  const sql = `
    insert into whoop_recoveries (id, whoop_user_id, cycle_id, sleep_id, raw, updated_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict (id)
    do update set
      whoop_user_id = excluded.whoop_user_id,
      cycle_id = excluded.cycle_id,
      sleep_id = excluded.sleep_id,
      raw = excluded.raw,
      updated_at = now();
  `;
  await db.query(sql, [id, whoopUserId, cycleId || null, sleepId || null, raw]);
}

async function upsertCycle({ id, whoopUserId, startTime, endTime, raw }) {
  const sql = `
    insert into whoop_cycles (id, whoop_user_id, start_time, end_time, raw, updated_at)
    values ($1,$2,$3,$4,$5,now())
    on conflict (id)
    do update set
      whoop_user_id = excluded.whoop_user_id,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      raw = excluded.raw,
      updated_at = now();
  `;
  await db.query(sql, [id, whoopUserId, startTime, endTime, raw]);
}

module.exports = { upsertWorkout, upsertSleep, upsertRecovery, upsertCycle };