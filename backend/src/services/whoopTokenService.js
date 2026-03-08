const { refreshAccessToken } = require("./whoopAuthService");
const {
  updateTokensByAppUserId,
  updateTokensByWhoopUserId,
} = require("../repositories/whoopConnectionRepo");

function isExpiredOrNear(expiresAtIso, bufferSeconds = 120) {
  if (!expiresAtIso) return true;

  const expiresAt = new Date(expiresAtIso).getTime();
  return Date.now() >= expiresAt - bufferSeconds * 1000;
}

function computeExpiresAt(expiresInSec) {
  if (typeof expiresInSec !== "number") return null;
  return new Date(Date.now() + expiresInSec * 1000).toISOString();
}

/**
 * Use when you have a connection row looked up by app_user_id
 */
async function getValidAccessTokenForAppUser(conn) {
  if (!conn) throw new Error("Missing connection");

  if (!isExpiredOrNear(conn.expires_at)) {
    return conn.access_token;
  }

  if (!conn.refresh_token) {
    throw new Error("No refresh_token stored; user must reconnect WHOOP");
  }

  const refreshed = await refreshAccessToken({
    refreshToken: conn.refresh_token,
  });

  const newAccessToken = refreshed.access_token;
  const newRefreshToken = refreshed.refresh_token || conn.refresh_token;
  const newScopes = refreshed.scope || conn.scopes || null;
  const newExpiresAt = computeExpiresAt(refreshed.expires_in);

  await updateTokensByAppUserId({
    appUserId: conn.app_user_id,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: newExpiresAt,
    scopes: newScopes,
  });

  return newAccessToken;
}

/**
 * Use when you have a connection row looked up by whoop_user_id
 */
async function getValidAccessTokenForWhoopUser(conn) {
  if (!conn) throw new Error("Missing connection");

  if (!isExpiredOrNear(conn.expires_at)) {
    return conn.access_token;
  }

  if (!conn.refresh_token) {
    throw new Error("No refresh_token stored; user must reconnect WHOOP");
  }

  const refreshed = await refreshAccessToken({
    refreshToken: conn.refresh_token,
  });

  const newAccessToken = refreshed.access_token;
  const newRefreshToken = refreshed.refresh_token || conn.refresh_token;
  const newScopes = refreshed.scope || conn.scopes || null;
  const newExpiresAt = computeExpiresAt(refreshed.expires_in);

  await updateTokensByWhoopUserId({
    whoopUserId: conn.whoop_user_id,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: newExpiresAt,
    scopes: newScopes,
  });

  return newAccessToken;
}

module.exports = {
  getValidAccessTokenForAppUser,
  getValidAccessTokenForWhoopUser,
};