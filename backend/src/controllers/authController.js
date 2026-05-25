// src/controllers/authController.js
const crypto = require("crypto");
const axios = require("axios");

const { getProfile } = require("../services/whoopApiService");
const { upsertConnection } = require("../repositories/whoopConnectionRepo");

const WHOOP_AUTH_BASE = "https://api.prod.whoop.com";

function getPwaRedirectUrl(status) {
  const frontendUrl = (
    process.env.PWA_FRONTEND_URL || "https://zeamhealthappfrontend.netlify.app"
  ).replace(/\/+$/, "");

  return `${frontendUrl}/body?whoop=${encodeURIComponent(status)}`;
}

// --- helpers: signed OAuth state ---
function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function hmacSha256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * State format:
 * base64url(JSON payload) + "." + signature
 *
 * payload = { app_user_id, nonce, iat }
 */
function signState(payloadObj) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("Missing OAUTH_STATE_SECRET");

  const payload = base64url(JSON.stringify(payloadObj));
  const sig = hmacSha256(secret, payload);

  return `${payload}.${sig}`;
}

function verifyState(state) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("Missing OAUTH_STATE_SECRET");

  const parts = String(state || "").split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expected = hmacSha256(secret, payload);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });

  return `${WHOOP_AUTH_BASE}/oauth/oauth2/auth?${params.toString()}`;
}

// 1) Start OAuth: returns the URL to open
exports.startWhoopAuth = async (req, res) => {
  try {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const redirectUri = process.env.WHOOP_REDIRECT_URI;
    const scopes = process.env.WHOOP_SCOPES;

    const appUserId = String(req.query.app_user_id || "").trim();

    if (!appUserId) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing app_user_id. Use /auth/whoop/start?app_user_id=USER123",
      });
    }

    if (!clientId || !redirectUri || !scopes) {
      return res.status(500).json({
        ok: false,
        error:
          "Missing WHOOP_CLIENT_ID / WHOOP_REDIRECT_URI / WHOOP_SCOPES in environment variables",
      });
    }

    const state = signState({
      app_user_id: appUserId,
      nonce: crypto.randomBytes(16).toString("hex"),
      iat: Date.now(),
    });

    const url = buildAuthorizeUrl({
      clientId,
      redirectUri,
      scopes,
      state,
    });

    return res.json({ ok: true, url });
  } catch (err) {
    console.error("WHOOP start auth failed:", err);

    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to start WHOOP auth",
    });
  }
};

// 2) Callback: exchange code -> tokens -> store connection -> redirect to PWA
exports.whoopCallback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.redirect(303, getPwaRedirectUrl("failed"));
    }

    if (!state) {
      return res.redirect(303, getPwaRedirectUrl("failed"));
    }

    const decoded = verifyState(state);

    if (!decoded || !decoded.app_user_id) {
      return res.redirect(303, getPwaRedirectUrl("failed"));
    }

    const appUserId = decoded.app_user_id;

    const tokenUrl = `${WHOOP_AUTH_BASE}/oauth/oauth2/token`;

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: process.env.WHOOP_REDIRECT_URI,
      client_id: process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET,
    });

    const tokenResp = await axios.post(tokenUrl, form.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const tokens = tokenResp.data;

    console.log("WHOOP token exchange successful for app_user_id:", appUserId);

    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token || null;
    const expiresIn = tokens.expires_in;
    const scopes = tokens.scope || process.env.WHOOP_SCOPES || null;

    if (!accessToken) {
      console.error("WHOOP token exchange returned no access_token");
      return res.redirect(303, getPwaRedirectUrl("failed"));
    }

    const profile = await getProfile(accessToken);

    const whoopUserId = profile?.user_id || profile?.id || profile?.user?.id;

    if (!whoopUserId) {
      console.error("Could not read WHOOP user id from profile:", profile);
      return res.redirect(303, getPwaRedirectUrl("failed"));
    }

    const expiresAt =
      typeof expiresIn === "number"
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;

    await upsertConnection({
      appUserId,
      whoopUserId: String(whoopUserId),
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
    });

    return res.redirect(303, getPwaRedirectUrl("connected"));
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || { message: err.message };

    console.error("WHOOP callback failed:", {
      status,
      details: data,
    });

    return res.redirect(303, getPwaRedirectUrl("failed"));
  }
};
