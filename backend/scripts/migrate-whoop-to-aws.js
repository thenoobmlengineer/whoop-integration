require("dotenv").config();
const { Client } = require("pg");
const crypto = require("crypto");

const OLD_WHOOP_DATABASE_URL = process.env.OLD_WHOOP_DATABASE_URL;
const AWS_DATABASE_URL = process.env.AWS_DATABASE_URL;

if (!OLD_WHOOP_DATABASE_URL || !AWS_DATABASE_URL) {
  console.error("Missing OLD_WHOOP_DATABASE_URL or AWS_DATABASE_URL");
  process.exit(1);
}

const oldDb = new Client({
  connectionString: OLD_WHOOP_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const awsDb = new Client({
  connectionString: AWS_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function stableId(prefix, value) {
  const hash = crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 24);
  return `${prefix}_${hash}`;
}

function asArrayScopes(scopes) {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes;
  return String(scopes)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

function get(obj, path) {
  return path.split(".").reduce((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    return acc[key];
  }, obj);
}

function extractRecovery(raw) {
  const score = raw?.score || raw?.data?.score || {};
  return {
    score: safeNumber(score.recovery_score),
    restingHeartRate: safeNumber(score.resting_heart_rate),
    hrvRmssdMs: safeNumber(score.hrv_rmssd_milli),
    respiratoryRate: safeNumber(score.respiratory_rate),
    skinTempCelsius: safeNumber(score.skin_temp_celsius),
    spo2Percent: safeNumber(score.spo2_percentage),
    createdAtWhoop: raw?.created_at || raw?.updated_at || null,
  };
}

function extractCycle(raw) {
  const score = raw?.score || raw?.data?.score || {};
  return {
    strain: safeNumber(score.strain),
    kilojoule: safeNumber(score.kilojoule),
  };
}

function extractSleep(raw) {
  const score = raw?.score || raw?.data?.score || {};
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
  const score = raw?.score || raw?.data?.score || {};
  return {
    sportId: safeInt(raw?.sport_id),
    strain: safeNumber(score.strain),
    kilojoule: safeNumber(score.kilojoule),
    averageHr: safeInt(score.average_heart_rate),
    maxHr: safeInt(score.max_heart_rate),
  };
}

async function tableCount(client, sql) {
  const result = await client.query(sql);
  return Number(result.rows[0].count);
}

async function main() {
  await oldDb.connect();
  await awsDb.connect();

  console.log("Connected to old WHOOP DB and AWS DB");

  await awsDb.query("BEGIN");

  try {
    const oldConnections = await oldDb.query(`
      SELECT
        id,
        app_user_id,
        whoop_user_id,
        access_token,
        refresh_token,
        expires_at,
        scopes,
        created_at,
        updated_at
      FROM public.whoop_connections
      ORDER BY id
    `);

    const connectionIdByWhoopUserId = new Map();

    console.log(`Migrating ${oldConnections.rows.length} WHOOP connections...`);

    for (const conn of oldConnections.rows) {
      const awsConnectionId = stableId("whoop_conn", conn.id);
      connectionIdByWhoopUserId.set(String(conn.whoop_user_id), awsConnectionId);

      const patientCheck = await awsDb.query(
        `SELECT id FROM "zeam_platform"."Patient" WHERE id = $1 LIMIT 1`,
        [conn.app_user_id]
      );

      if (patientCheck.rowCount === 0) {
        throw new Error(
          `No AWS Patient found for old app_user_id: ${conn.app_user_id}. Create mapping before migration.`
        );
      }

      await awsDb.query(
        `
        INSERT INTO "zeam_platform"."PatientDeviceConnection" (
          id,
          "patientId",
          type,
          "externalUserId",
          "externalDeviceId",
          "displayName",
          status,
          "accessTokenEnc",
          "refreshTokenEnc",
          "tokenType",
          scopes,
          "expiresAt",
          "connectedAt",
          "lastSyncedAt",
          meta,
          "createdAt",
          "updatedAt"
        )
        VALUES (
          $1, $2, 'WHOOP', $3, NULL, 'WHOOP', 'ACTIVE',
          $4, $5, 'Bearer', $6, $7, $8, $9, $10, $11, $12
        )
        ON CONFLICT (id) DO UPDATE SET
          "patientId" = EXCLUDED."patientId",
          "externalUserId" = EXCLUDED."externalUserId",
          "accessTokenEnc" = EXCLUDED."accessTokenEnc",
          "refreshTokenEnc" = EXCLUDED."refreshTokenEnc",
          scopes = EXCLUDED.scopes,
          "expiresAt" = EXCLUDED."expiresAt",
          "lastSyncedAt" = EXCLUDED."lastSyncedAt",
          meta = EXCLUDED.meta,
          "updatedAt" = NOW()
        `,
        [
          awsConnectionId,
          conn.app_user_id,
          conn.whoop_user_id,
          conn.access_token,
          conn.refresh_token,
          asArrayScopes(conn.scopes),
          conn.expires_at,
          conn.created_at || new Date(),
          conn.updated_at,
          JSON.stringify({
            migratedFrom: "old_whoop_db",
            oldConnectionId: conn.id,
            oldAppUserId: conn.app_user_id,
          }),
          conn.created_at || new Date(),
          conn.updated_at || new Date(),
        ]
      );
    }

    const cycles = await oldDb.query(`
      SELECT id, whoop_user_id, start_time, end_time, raw, updated_at
      FROM public.whoop_cycles
      ORDER BY updated_at
    `);

    console.log(`Migrating ${cycles.rows.length} WHOOP cycles...`);

    for (const row of cycles.rows) {
      const connectionId = connectionIdByWhoopUserId.get(String(row.whoop_user_id));
      if (!connectionId) continue;

      const extracted = extractCycle(row.raw);

      await awsDb.query(
        `
        INSERT INTO "zeam_platform"."WhoopCycle" (
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
        VALUES ($1, $2, $3, 'BACKFILL', $4, $5, $6, $7, $8, NOW(), $9)
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
          stableId("whoop_cycle", row.id),
          connectionId,
          row.id,
          row.start_time,
          row.end_time,
          extracted.strain,
          extracted.kilojoule,
          row.raw,
          row.updated_at || new Date(),
        ]
      );
    }

    const recoveries = await oldDb.query(`
      SELECT id, whoop_user_id, cycle_id, raw, updated_at, sleep_id
      FROM public.whoop_recoveries
      ORDER BY updated_at
    `);

    console.log(`Migrating ${recoveries.rows.length} WHOOP recoveries...`);

    for (const row of recoveries.rows) {
      const connectionId = connectionIdByWhoopUserId.get(String(row.whoop_user_id));
      if (!connectionId) continue;

      const extracted = extractRecovery(row.raw);

      await awsDb.query(
        `
        INSERT INTO "zeam_platform"."WhoopRecovery" (
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
        VALUES ($1, $2, $3, 'BACKFILL', $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
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
          stableId("whoop_recovery", row.id),
          connectionId,
          row.id,
          extracted.createdAtWhoop,
          extracted.score,
          extracted.restingHeartRate,
          extracted.hrvRmssdMs,
          extracted.respiratoryRate,
          extracted.skinTempCelsius,
          extracted.spo2Percent,
          row.raw,
          row.updated_at || new Date(),
        ]
      );
    }

    const sleeps = await oldDb.query(`
      SELECT id, whoop_user_id, start_time, end_time, raw, updated_at
      FROM public.whoop_sleeps
      ORDER BY updated_at
    `);

    console.log(`Migrating ${sleeps.rows.length} WHOOP sleeps...`);

    for (const row of sleeps.rows) {
      const connectionId = connectionIdByWhoopUserId.get(String(row.whoop_user_id));
      if (!connectionId) continue;

      const extracted = extractSleep(row.raw);

      await awsDb.query(
        `
        INSERT INTO "zeam_platform"."WhoopSleep" (
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
          $1, $2, $3, 'BACKFILL', $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, NOW(), $17
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
          stableId("whoop_sleep", row.id),
          connectionId,
          row.id,
          row.start_time,
          row.end_time,
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
          row.raw,
          row.updated_at || new Date(),
        ]
      );
    }

    const workouts = await oldDb.query(`
      SELECT id, whoop_user_id, start_time, end_time, raw, updated_at
      FROM public.whoop_workouts
      ORDER BY updated_at
    `);

    console.log(`Migrating ${workouts.rows.length} WHOOP workouts...`);

    for (const row of workouts.rows) {
      const connectionId = connectionIdByWhoopUserId.get(String(row.whoop_user_id));
      if (!connectionId) continue;

      const extracted = extractWorkout(row.raw);

      await awsDb.query(
        `
        INSERT INTO "zeam_platform"."WhoopWorkout" (
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
        VALUES ($1, $2, $3, 'BACKFILL', $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
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
          stableId("whoop_workout", row.id),
          connectionId,
          row.id,
          extracted.sportId,
          extracted.strain,
          extracted.kilojoule,
          extracted.averageHr,
          extracted.maxHr,
          row.start_time,
          row.end_time,
          row.raw,
          row.updated_at || new Date(),
        ]
      );
    }

    await awsDb.query("COMMIT");

    console.log("Migration committed successfully.");

    console.log("AWS counts after migration:");

    const counts = [
      ["PatientDeviceConnection WHOOP", `SELECT COUNT(*) FROM "zeam_platform"."PatientDeviceConnection" WHERE type = 'WHOOP'`],
      ["WhoopCycle", `SELECT COUNT(*) FROM "zeam_platform"."WhoopCycle"`],
      ["WhoopRecovery", `SELECT COUNT(*) FROM "zeam_platform"."WhoopRecovery"`],
      ["WhoopSleep", `SELECT COUNT(*) FROM "zeam_platform"."WhoopSleep"`],
      ["WhoopWorkout", `SELECT COUNT(*) FROM "zeam_platform"."WhoopWorkout"`],
    ];

    for (const [name, sql] of counts) {
      const count = await tableCount(awsDb, sql);
      console.log(`${name}: ${count}`);
    }
  } catch (error) {
    await awsDb.query("ROLLBACK");
    console.error("Migration failed. Rolled back AWS changes.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await oldDb.end();
    await awsDb.end();
  }
}

main();