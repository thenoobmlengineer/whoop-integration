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

function normalizeScopes(scopes) {
  if (!scopes) return [];
  if (Array.isArray(scopes)) return scopes;

  return String(scopes)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeConnection(row) {
  if (!row) return null;

  return {
    id: row.id,
    app_user_id: row.app_user_id,
    whoop_user_id: row.whoop_user_id,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    scopes: row.scopes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
  };
}

async function getByAppUserId(appUserId) {
  const sql = `
    SELECT
      id,
      "patientId" AS app_user_id,
      "externalUserId" AS whoop_user_id,
      "accessTokenEnc" AS access_token,
      "refreshTokenEnc" AS refresh_token,
      "expiresAt" AS expires_at,
      scopes,
      status,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
    FROM ${table("PatientDeviceConnection")}
    WHERE "patientId" = $1
      AND type = 'WHOOP'
      AND "archivedAt" IS NULL
    ORDER BY "updatedAt" DESC
    LIMIT 1
  `;
  // console.log("getByAppUserId SQL:", sql);
  // console.log("getByAppUserId appUserId:", appUserId);
  const result = await db.query(sql, [appUserId]);
  return normalizeConnection(result.rows[0]);
}

async function getByWhoopUserId(whoopUserId) {
  const sql = `
    SELECT
      id,
      "patientId" AS app_user_id,
      "externalUserId" AS whoop_user_id,
      "accessTokenEnc" AS access_token,
      "refreshTokenEnc" AS refresh_token,
      "expiresAt" AS expires_at,
      scopes,
      status,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
    FROM ${table("PatientDeviceConnection")}
    WHERE "externalUserId" = $1
      AND type = 'WHOOP'
      AND "archivedAt" IS NULL
    ORDER BY "updatedAt" DESC
    LIMIT 1
  `;

  const result = await db.query(sql, [String(whoopUserId)]);
  return normalizeConnection(result.rows[0]);
}

async function upsertConnection({
  appUserId,
  whoopUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const patientCheck = await db.query(
    `SELECT id FROM ${table("Patient")} WHERE id = $1 LIMIT 1`,
    [appUserId]
  );

  if (patientCheck.rowCount === 0) {
    throw new Error(`No AWS Patient found for app_user_id/patientId: ${appUserId}`);
  }

  const existing = await db.query(
    `
    SELECT id
    FROM ${table("PatientDeviceConnection")}
    WHERE "patientId" = $1
      AND type = 'WHOOP'
      AND "archivedAt" IS NULL
    ORDER BY "updatedAt" DESC
    LIMIT 1
    `,
    [appUserId]
  );

  const id =
    existing.rows[0]?.id || makeId("whoop_conn", `${appUserId}:${whoopUserId}`);

  const sql = `
    INSERT INTO ${table("PatientDeviceConnection")} (
      id,
      "patientId",
      type,
      "externalUserId",
      "displayName",
      status,
      "accessTokenEnc",
      "refreshTokenEnc",
      "tokenType",
      scopes,
      "expiresAt",
      "connectedAt",
      "lastSeenAt",
      meta,
      "createdAt",
      "updatedAt"
    )
    VALUES (
      $1, $2, 'WHOOP', $3, 'WHOOP', 'ACTIVE',
      $4, $5, 'Bearer', $6::text[], $7,
      NOW(), NOW(), $8::jsonb, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      "externalUserId" = EXCLUDED."externalUserId",
      status = 'ACTIVE',
      "accessTokenEnc" = EXCLUDED."accessTokenEnc",
      "refreshTokenEnc" = EXCLUDED."refreshTokenEnc",
      "tokenType" = EXCLUDED."tokenType",
      scopes = EXCLUDED.scopes,
      "expiresAt" = EXCLUDED."expiresAt",
      "lastSeenAt" = NOW(),
      meta = EXCLUDED.meta,
      "updatedAt" = NOW()
    RETURNING
      id,
      "patientId" AS app_user_id,
      "externalUserId" AS whoop_user_id,
      "accessTokenEnc" AS access_token,
      "refreshTokenEnc" AS refresh_token,
      "expiresAt" AS expires_at,
      scopes,
      status,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
  `;

  const result = await db.query(sql, [
    id,
    appUserId,
    String(whoopUserId),
    accessToken,
    refreshToken,
    normalizeScopes(scopes),
    expiresAt,
    JSON.stringify({
      provider: "WHOOP",
      source: "whoop_oauth_callback",
    }),
  ]);

  return normalizeConnection(result.rows[0]);
}

async function updateTokensByConnectionId({
  connectionId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const sql = `
    UPDATE ${table("PatientDeviceConnection")}
    SET
      "accessTokenEnc" = COALESCE($2, "accessTokenEnc"),
      "refreshTokenEnc" = COALESCE($3, "refreshTokenEnc"),
      "expiresAt" = $4,
      scopes = COALESCE($5::text[], scopes),
      "lastSeenAt" = NOW(),
      "updatedAt" = NOW()
    WHERE id = $1
    RETURNING
      id,
      "patientId" AS app_user_id,
      "externalUserId" AS whoop_user_id,
      "accessTokenEnc" AS access_token,
      "refreshTokenEnc" AS refresh_token,
      "expiresAt" AS expires_at,
      scopes,
      status,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
  `;

  const result = await db.query(sql, [
    connectionId,
    accessToken || null,
    refreshToken || null,
    expiresAt || null,
    scopes ? normalizeScopes(scopes) : null,
  ]);

  return normalizeConnection(result.rows[0]);
}

async function deleteByAppUserId(appUserId) {
  const sql = `
    UPDATE ${table("PatientDeviceConnection")}
    SET
      status = 'DISCONNECTED',
      "disconnectedAt" = NOW(),
      "accessTokenEnc" = NULL,
      "refreshTokenEnc" = NULL,
      "updatedAt" = NOW()
    WHERE "patientId" = $1
      AND type = 'WHOOP'
      AND "archivedAt" IS NULL
    RETURNING
      id,
      "patientId" AS app_user_id,
      "externalUserId" AS whoop_user_id,
      "accessTokenEnc" AS access_token,
      "refreshTokenEnc" AS refresh_token,
      "expiresAt" AS expires_at,
      scopes,
      status,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at
  `;

  const result = await db.query(sql, [appUserId]);
  return normalizeConnection(result.rows[0]);
}

module.exports = {
  getByAppUserId,
  getByWhoopUserId,
  upsertConnection,
  updateTokensByConnectionId,
  deleteByAppUserId,
};