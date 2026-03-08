const db = require("../db");

/**
 * Insert or update WHOOP connection for an app user
 */
async function upsertConnection({
  appUserId,
  whoopUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const sql = `
    insert into whoop_connections (
      app_user_id,
      whoop_user_id,
      access_token,
      refresh_token,
      expires_at,
      scopes
    )
    values ($1,$2,$3,$4,$5,$6)
    on conflict (app_user_id)
    do update set
      whoop_user_id = excluded.whoop_user_id,
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes,
      updated_at = now()
    returning *;
  `;

  const res = await db.query(sql, [
    String(appUserId),
    String(whoopUserId),
    accessToken,
    refreshToken || null,
    expiresAt || null,
    scopes || null,
  ]);

  return res.rows[0];
}

/**
 * Get connection by app user id
 */
async function getByAppUserId(appUserId) {
  const res = await db.query(
    `select * from whoop_connections where app_user_id = $1 limit 1`,
    [String(appUserId)]
  );
  return res.rows[0] || null;
}

/**
 * Get connection by WHOOP user id
 */
async function getByWhoopUserId(whoopUserId) {
  const res = await db.query(
    `select * from whoop_connections where whoop_user_id = $1 limit 1`,
    [String(whoopUserId)]
  );
  return res.rows[0] || null;
}

/**
 * Update tokens by app user id
 */
async function updateTokensByAppUserId({
  appUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const sql = `
    update whoop_connections
    set access_token = $2,
        refresh_token = coalesce($3, refresh_token),
        expires_at = $4,
        scopes = coalesce($5, scopes),
        updated_at = now()
    where app_user_id = $1
    returning *;
  `;

  const res = await db.query(sql, [
    String(appUserId),
    accessToken,
    refreshToken || null,
    expiresAt || null,
    scopes || null,
  ]);

  return res.rows[0] || null;
}

/**
 * Update tokens by WHOOP user id
 */
async function updateTokensByWhoopUserId({
  whoopUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const sql = `
    update whoop_connections
    set access_token = $2,
        refresh_token = coalesce($3, refresh_token),
        expires_at = $4,
        scopes = coalesce($5, scopes),
        updated_at = now()
    where whoop_user_id = $1
    returning *;
  `;

  const res = await db.query(sql, [
    String(whoopUserId),
    accessToken,
    refreshToken || null,
    expiresAt || null,
    scopes || null,
  ]);

  return res.rows[0] || null;
}

module.exports = {
  upsertConnection,
  getByAppUserId,
  getByWhoopUserId,
  updateTokensByAppUserId,
  updateTokensByWhoopUserId,
};