const crypto = require("crypto");
const db = require("../db");
const { table } = require("../db/schema");

function makeId(prefix, value) {
  const hash = crypto
    .createHash("sha1")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);

  return `${prefix}_${hash}`;
}

function safeNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeInt(value) {
  const n = safeNumber(value);
  return n === null ? null : Math.round(n);
}

async function getConnectionIdByWhoopUserId(whoopUserId) {
  const result = await db.query(
    `
    SELECT id
    FROM ${table("PatientDeviceConnection")}
    WHERE "externalUserId" = $1
      AND type = 'WHOOP'
      AND "archivedAt" IS NULL
    ORDER BY "updatedAt" DESC
    LIMIT 1
    `,
    [String(whoopUserId)]
  );

  const connectionId = result.rows[0]?.id;

  if (!connectionId) {
    throw new Error(`No AWS WHOOP connection found for whoop_user_id: ${whoopUserId}`);
  }

  return connectionId;
}

async function touchConnection(connectionId) {
  await db.query(
    `
    UPDATE ${table("PatientDeviceConnection")}
    SET "lastSyncedAt" = NOW(), "lastSeenAt" = NOW(), "updatedAt" = NOW()
    WHERE id = $1
    `,
    [connectionId]
  );
}

function extractCycle(raw) {
  const score = raw?.score || {};

  return {
    strain: safeNumber(score.strain),
    kilojoule: safeNumber(score.kilojoule),
  };
}

function extractRecovery(raw) {
  const score = raw?.score || {};

  return {
    createdAtWhoop: raw?.created_at || raw?.updated_at || null,
    score: safeNumber(score.recovery_score),
    restingHeartRate: safeNumber(score.resting_heart_rate),
    hrvRmssdMs: safeNumber(score.hrv_rmssd_milli),
    respiratoryRate: safeNumber(score.respiratory_rate),
    skinTempCelsius: safeNumber(score.skin_temp_celsius),
    spo2Percent: safeNumber(score.spo2_percentage),
  };
}

function extractSleep(raw) {
  const score = raw?.score || {};
  const stage = score.stage_summary || {};
  const needed = score.sleep_needed || {};

  return {
    timezoneOffset: raw?.timezone_offset || null,
    totalSleepMs:
      safeInt(stage.total_in_bed_time_milli) ??
      safeInt(stage.total_sleep_time_milli) ??
      null,
    sleepEfficiency: safeNumber(score.sleep_efficiency_percentage),
    sleepPerformance: safeNumber(score.sleep_performance_percentage),
    sleepNeedMs: safeInt(needed.baseline_milli),
    remMs: safeInt(stage.total_rem_sleep_time_milli),
    slowWaveMs: safeInt(stage.total_slow_wave_sleep_time_milli),
    lightMs: safeInt(stage.total_light_sleep_time_milli),
    wakeMs: safeInt(stage.total_awake_time_milli),
    latencyMs: safeInt(stage.latency_milli),
  };
}

function extractWorkout(raw) {
  const score = raw?.score || {};

  return {
    sportId: safeInt(raw?.sport_id),
    strain: safeNumber(score.strain),
    kilojoule: safeNumber(score.kilojoule),
    averageHr: safeInt(score.average_heart_rate),
    maxHr: safeInt(score.max_heart_rate),
  };
}

async function upsertCycle({ id, whoopUserId, startTime, endTime, raw }) {
  const connectionId = await getConnectionIdByWhoopUserId(whoopUserId);
  const extracted = extractCycle(raw);
  const externalId = String(id);

  await db.query(
    `
    INSERT INTO ${table("WhoopCycle")} (
      id,
      "connectionId",
      "externalId",
      "recordSource",
      start,
      "end",
      strain,
      kilojoule,
      "rawPayload",
      "createdAt",
      "updatedAt"
    )
    VALUES ($1, $2, $3, 'API', $4, $5, $6, $7, $8::jsonb, NOW(), NOW())
    ON CONFLICT ("externalId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId",
      start = EXCLUDED.start,
      "end" = EXCLUDED."end",
      strain = EXCLUDED.strain,
      kilojoule = EXCLUDED.kilojoule,
      "rawPayload" = EXCLUDED."rawPayload",
      "updatedAt" = NOW()
    `,
    [
      makeId("whoop_cycle", externalId),
      connectionId,
      externalId,
      startTime,
      endTime,
      extracted.strain,
      extracted.kilojoule,
      JSON.stringify(raw || {}),
    ]
  );

  await touchConnection(connectionId);
}

async function upsertRecovery({ id, whoopUserId, raw }) {
  const connectionId = await getConnectionIdByWhoopUserId(whoopUserId);
  const extracted = extractRecovery(raw);
  const externalId = String(id);

  await db.query(
    `
    INSERT INTO ${table("WhoopRecovery")} (
      id,
      "connectionId",
      "externalId",
      "recordSource",
      "createdAtWhoop",
      score,
      "restingHeartRate",
      "hrvRmssdMs",
      "respiratoryRate",
      "skinTempCelsius",
      "spo2Percent",
      "rawPayload",
      "createdAt",
      "updatedAt"
    )
    VALUES ($1, $2, $3, 'API', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
    ON CONFLICT ("externalId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId",
      "createdAtWhoop" = EXCLUDED."createdAtWhoop",
      score = EXCLUDED.score,
      "restingHeartRate" = EXCLUDED."restingHeartRate",
      "hrvRmssdMs" = EXCLUDED."hrvRmssdMs",
      "respiratoryRate" = EXCLUDED."respiratoryRate",
      "skinTempCelsius" = EXCLUDED."skinTempCelsius",
      "spo2Percent" = EXCLUDED."spo2Percent",
      "rawPayload" = EXCLUDED."rawPayload",
      "updatedAt" = NOW()
    `,
    [
      makeId("whoop_recovery", externalId),
      connectionId,
      externalId,
      extracted.createdAtWhoop,
      extracted.score,
      extracted.restingHeartRate,
      extracted.hrvRmssdMs,
      extracted.respiratoryRate,
      extracted.skinTempCelsius,
      extracted.spo2Percent,
      JSON.stringify(raw || {}),
    ]
  );

  await touchConnection(connectionId);
}

async function upsertSleep({ id, whoopUserId, startTime, endTime, raw }) {
  const connectionId = await getConnectionIdByWhoopUserId(whoopUserId);
  const extracted = extractSleep(raw);
  const externalId = String(id);

  await db.query(
    `
    INSERT INTO ${table("WhoopSleep")} (
      id,
      "connectionId",
      "externalId",
      "recordSource",
      start,
      "end",
      "timezoneOffset",
      "totalSleepMs",
      "sleepEfficiency",
      "sleepPerformance",
      "sleepNeedMs",
      "remMs",
      "slowWaveMs",
      "lightMs",
      "wakeMs",
      "latencyMs",
      "rawPayload",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1, $2, $3, 'API', $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16::jsonb, NOW(), NOW()
    )
    ON CONFLICT ("externalId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId",
      start = EXCLUDED.start,
      "end" = EXCLUDED."end",
      "timezoneOffset" = EXCLUDED."timezoneOffset",
      "totalSleepMs" = EXCLUDED."totalSleepMs",
      "sleepEfficiency" = EXCLUDED."sleepEfficiency",
      "sleepPerformance" = EXCLUDED."sleepPerformance",
      "sleepNeedMs" = EXCLUDED."sleepNeedMs",
      "remMs" = EXCLUDED."remMs",
      "slowWaveMs" = EXCLUDED."slowWaveMs",
      "lightMs" = EXCLUDED."lightMs",
      "wakeMs" = EXCLUDED."wakeMs",
      "latencyMs" = EXCLUDED."latencyMs",
      "rawPayload" = EXCLUDED."rawPayload",
      "updatedAt" = NOW()
    `,
    [
      makeId("whoop_sleep", externalId),
      connectionId,
      externalId,
      startTime,
      endTime,
      extracted.timezoneOffset,
      extracted.totalSleepMs,
      extracted.sleepEfficiency,
      extracted.sleepPerformance,
      extracted.sleepNeedMs,
      extracted.remMs,
      extracted.slowWaveMs,
      extracted.lightMs,
      extracted.wakeMs,
      extracted.latencyMs,
      JSON.stringify(raw || {}),
    ]
  );

  await touchConnection(connectionId);
}

async function upsertWorkout({ id, whoopUserId, startTime, endTime, raw }) {
  const connectionId = await getConnectionIdByWhoopUserId(whoopUserId);
  const extracted = extractWorkout(raw);
  const externalId = String(id);

  await db.query(
    `
    INSERT INTO ${table("WhoopWorkout")} (
      id,
      "connectionId",
      "externalId",
      "recordSource",
      "sportId",
      strain,
      kilojoule,
      "averageHr",
      "maxHr",
      start,
      "end",
      "rawPayload",
      "createdAt",
      "updatedAt"
    )
    VALUES ($1, $2, $3, 'API', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
    ON CONFLICT ("externalId") DO UPDATE SET
      "connectionId" = EXCLUDED."connectionId",
      "sportId" = EXCLUDED."sportId",
      strain = EXCLUDED.strain,
      kilojoule = EXCLUDED.kilojoule,
      "averageHr" = EXCLUDED."averageHr",
      "maxHr" = EXCLUDED."maxHr",
      start = EXCLUDED.start,
      "end" = EXCLUDED."end",
      "rawPayload" = EXCLUDED."rawPayload",
      "updatedAt" = NOW()
    `,
    [
      makeId("whoop_workout", externalId),
      connectionId,
      externalId,
      extracted.sportId,
      extracted.strain,
      extracted.kilojoule,
      extracted.averageHr,
      extracted.maxHr,
      startTime,
      endTime,
      JSON.stringify(raw || {}),
    ]
  );

  await touchConnection(connectionId);
}

module.exports = {
  upsertWorkout,
  upsertSleep,
  upsertRecovery,
  upsertCycle,
};