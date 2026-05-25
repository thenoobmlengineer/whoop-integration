//src/services/whoopAuthService.js
const axios = require("axios");

const WHOOP_AUTH_BASE = "https://api.prod.whoop.com";

async function refreshAccessToken({ refreshToken }) {
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }

  const tokenUrl = `${WHOOP_AUTH_BASE}/oauth/oauth2/token`;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.WHOOP_CLIENT_ID,
    client_secret: process.env.WHOOP_CLIENT_SECRET,
  });

  const resp = await axios.post(tokenUrl, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  return resp.data;
}

module.exports = { refreshAccessToken };