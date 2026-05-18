const db = require("../db");

/**
 * Insert or update WHOOP connection for an app user
 * Handles reconnects by either app_user_id OR whoop_user_id
 */
async function upsertConnection({
  appUserId,
  whoopUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const appId = String(appUserId);
  const whoopId = String(whoopUserId);

  // 1) Try to find existing row by app user OR whoop user
  const existingRes = await db.query(
    `
    select *
    from whoop_connections
    where app_user_id = $1 or whoop_user_id = $2
    limit 1
    `,
    [appId, whoopId]
  );

  const existing = existingRes.rows[0];

  // 2) If found, update the existing row
  if (existing) {
    const updateRes = await db.query(
      `
      update whoop_connections
      set
        app_user_id = $1,
        whoop_user_id = $2,
        access_token = $3,
        refresh_token = $4,
        expires_at = $5,
        scopes = $6,
        updated_at = now()
      where id = $7
      returning *;
      `,
      [
        appId,
        whoopId,
        accessToken,
        refreshToken || null,
        expiresAt || null,
        scopes || null,
        existing.id,
      ]
    );

    return updateRes.rows[0];
  }

  // 3) Otherwise insert a fresh row
  const insertRes = await db.query(
    `
    insert into whoop_connections (
      app_user_id,
      whoop_user_id,
      access_token,
      refresh_token,
      expires_at,
      scopes
    )
    values ($1,$2,$3,$4,$5,$6)
    returning *;
    `,
    [
      appId,
      whoopId,
      accessToken,
      refreshToken || null,
      expiresAt || null,
      scopes || null,
    ]
  );

  return insertRes.rows[0];
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

/**
 * Delete WHOOP connection by app user id.
 * This removes OAuth tokens and disconnects the WHOOP account from the app user.
 */
async function deleteByAppUserId(appUserId) {
  const res = await db.query(
    `
    delete from whoop_connections
    where app_user_id = $1
    returning app_user_id, whoop_user_id, updated_at;
    `,
    [String(appUserId)]
  );

  return res.rows[0] || null;
}

module.exports = {
  upsertConnection,
  getByAppUserId,
  getByWhoopUserId,
  updateTokensByAppUserId,
  updateTokensByWhoopUserId,
  deleteByAppUserId,
};
