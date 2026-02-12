const crypto = require("crypto");
const axios = require("axios");

const WHOOP_AUTH_BASE = "https://api.prod.whoop.com"; // WHOOP auth host (used in docs)

function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state
  });

  return `${WHOOP_AUTH_BASE}/oauth/oauth2/auth?${params.toString()}`;
}

// 1) Start OAuth: returns the URL to open
exports.startWhoopAuth = async (req, res) => {
  try {
    const clientId = process.env.WHOOP_CLIENT_ID;
    const redirectUri = process.env.WHOOP_REDIRECT_URI;
    const scopes = process.env.WHOOP_SCOPES;

    if (!clientId || !redirectUri || !scopes) {
      return res.status(500).json({
        ok: false,
        error: "Missing WHOOP_CLIENT_ID / WHOOP_REDIRECT_URI / WHOOP_SCOPES in .env"
      });
    }

    // Create a random state to protect against CSRF
    const state = crypto.randomBytes(16).toString("hex");

    // For now we return state to client (dev mode).
    // Later you’ll store state server-side (redis/db) and validate it on callback.
    const url = buildAuthorizeUrl({ clientId, redirectUri, scopes, state });

    return res.json({ ok: true, url, state });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// 2) Callback: exchange code -> tokens
exports.whoopCallback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send("Missing code");
    }

    // TODO (next step): validate state against what we issued
    // console.log("WHOOP state:", state);

    const tokenUrl = `${WHOOP_AUTH_BASE}/oauth/oauth2/token`;

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: process.env.WHOOP_REDIRECT_URI,
      client_id: process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET
    });

    const tokenResp = await axios.post(tokenUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    // tokenResp.data should include access_token, expires_in, token_type, refresh_token (if issued)
    // For dev: show it in browser (don’t do this in production)
    return res.json({ ok: true, tokens: tokenResp.data });
  } catch (err) {
    const status = err?.response?.status || 500;
    const data = err?.response?.data || { message: err.message };

    return res.status(status).json({
      ok: false,
      error: "Token exchange failed",
      details: data
    });
  }
};
