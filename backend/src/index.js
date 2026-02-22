// backend/src/index.js

const express = require("express");
const cors = require("cors");
require("dotenv").config();

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
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log("Webhook endpoint: POST /webhook/whoop");
  console.log("Debug endpoint: GET /debug/whoop-events?key=...&limit=...");
});