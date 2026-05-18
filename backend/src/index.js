// backend/src/index.js

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");

const whoopRoutes = require("./routes/whoopRoutes");
const authRoutes = require("./routes/authRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const debugRoutes = require("./routes/debugRoutes");

const { getProfile } = require("./services/whoopApiService");

const app = express();

app.use(cors());

// Capture raw body for WHOOP webhook signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Optional root route so "/" doesn't show Cannot GET /
app.get("/", (req, res) => {
  res.send("WHOOP backend running. Try /health");
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "whoop-backend" });
});

// DB health check
app.get("/health/db", async (req, res) => {
  try {
    const r = await db.query("select now() as now");
    res.json({ ok: true, db_time: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Version check
app.get("/_version", (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || "unknown",
    time: new Date().toISOString(),
  });
});

// ✅ WHOOP App-facing routes
app.use("/whoop", whoopRoutes);

// WHOOP OAuth routes
app.use("/auth", authRoutes);

// ✅ WHOOP Webhook routes (POST)
app.use("/webhook", webhookRoutes);

// ✅ Debug routes (GET)
app.use("/debug", debugRoutes);

/**
 * DEV TEST ONLY:
 * Pass access token as query param to validate API calls quickly.
 * Example:
 * http://localhost:3001/test/profile?token=YOUR_ACCESS_TOKEN
 */
app.get("/test/profile", async (req, res) => {
  try {
    const accessToken = req.query.token;

    if (!accessToken) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing token query param" });
    }

    const data = await getProfile(accessToken);
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(err?.response?.status || 500).json({
      ok: false,
      error: "Failed",
      details: err?.response?.data || err.message,
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0"() => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Listening to port 0.0.0.0`);
  console.log("Webhook endpoint: POST /webhook/whoop");
  console.log("Debug endpoint: GET /debug/whoop-events?key=...&limit=...");
  console.log("Whoop endpoint: GET /whoop/connection?app_user_id=...");
});
