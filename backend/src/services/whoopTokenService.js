// src/services/whoopTokenService.js
const { refreshAccessToken } = require("./whoopAuthService");
const { updateTokensByConnectionId } = require("../repositories/whoopConnectionRepo");

function isExpiredOrNear(expiresAtIso, bufferSeconds = 120) {
  if (!expiresAtIso) return true;

  const expiresAt = new Date(expiresAtIso).getTime();

  if (Number.isNaN(expiresAt)) return true;

  return Date.now() >= expiresAt - bufferSeconds * 1000;
}

function computeExpiresAt(expiresInSec) {
  const seconds = Number(expiresInSec);

  if (!Number.isFinite(seconds)) return null;

  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeScopes(scopes) {
  if (!scopes) return null;
  if (Array.isArray(scopes)) return scopes;

  return String(scopes)
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function refreshAndPersistConnectionToken(conn) {
  if (!conn) {
    throw new Error("Missing WHOOP connection");
  }

  if (!conn.id) {
    throw new Error("Missing WHOOP connection id");
  }

  if (!conn.refresh_token) {
    throw new Error("No refresh_token stored; user must reconnect WHOOP");
  }

  const refreshed = await refreshAccessToken({
    refreshToken: conn.refresh_token,
  });

  const newAccessToken = refreshed.access_token;

  if (!newAccessToken) {
    throw new Error("WHOOP refresh did not return an access_token");
  }

  const newRefreshToken = refreshed.refresh_token || conn.refresh_token;
  const newScopes = normalizeScopes(refreshed.scope || conn.scopes || null);
  const newExpiresAt = computeExpiresAt(refreshed.expires_in);

  await updateTokensByConnectionId({
    connectionId: conn.id,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresAt: newExpiresAt,
    scopes: newScopes,
  });

  return newAccessToken;
}

/**
 * Use when you have a connection row looked up by app_user_id.
 *
 * The connection row now comes from AWS PatientDeviceConnection,
 * but whoopConnectionRepo returns compatibility fields:
 * conn.access_token
 * conn.refresh_token
 * conn.expires_at
 */
async function getValidAccessTokenForAppUser(conn) {
  if (!conn) {
    throw new Error("Missing WHOOP connection");
  }

  if (!isExpiredOrNear(conn.expires_at)) {
    return conn.access_token;
  }

  return refreshAndPersistConnectionToken(conn);
}

/**
 * Use when you have a connection row looked up by whoop_user_id.
 *
 * Same logic as app user flow. The important part is that we update
 * by AWS connection id.
 */
async function getValidAccessTokenForWhoopUser(conn) {
  if (!conn) {
    throw new Error("Missing WHOOP connection");
  }

  if (!isExpiredOrNear(conn.expires_at)) {
    return conn.access_token;
  }

  return refreshAndPersistConnectionToken(conn);
}

module.exports = {
  getValidAccessTokenForAppUser,
  getValidAccessTokenForWhoopUser,
};