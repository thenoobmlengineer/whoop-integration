const db = require("../db");

async function upsertConnection({
  appUserId,
  whoopUserId,
  accessToken,
  refreshToken,
  expiresAt,
  scopes,
}) {
  const sql = `
    insert into whoop_connections (app_user_id, whoop_user_id, access_token, refresh_token, expires_at, scopes)
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
    appUserId,
    whoopUserId,
    accessToken,
    refreshToken || null,
    expiresAt || null,
    scopes || null,
  ]);

  return res.rows[0];
}

async function getByAppUserId(appUserId) {
  const res = await db.query(
    `select * from whoop_connections where app_user_id = $1 limit 1`,
    [appUserId]
  );
  return res.rows[0] || null;
}

async function getByWhoopUserId(whoopUserId) {
  const res = await db.query(
    `select * from whoop_connections where whoop_user_id = $1 limit 1`,
    [whoopUserId]
  );
  return res.rows[0] || null;
}

module.exports = { upsertConnection, getByAppUserId, getByWhoopUserId };