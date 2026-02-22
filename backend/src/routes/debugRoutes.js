const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

function mustHaveKey(req, res, next) {
  const key = req.query.key;
  if (!process.env.DEBUG_KEY) {
    return res.status(500).json({ ok: false, error: "DEBUG_KEY not set" });
  }
  if (key !== process.env.DEBUG_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// GET /debug/whoop-events?key=...&limit=50
router.get("/whoop-events", mustHaveKey, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);

    // Same path you are saving to in webhookController.js
    const filePath = path.join(
      "/opt/render/project/src/backend/src/controllers",
      "whoop_events.json"
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "whoop_events.json not found yet" });
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const events = JSON.parse(raw);

    const sliced = Array.isArray(events) ? events.slice(-limit) : events;

    return res.json({
      ok: true,
      count: Array.isArray(events) ? events.length : 0,
      returned: Array.isArray(sliced) ? sliced.length : 0,
      events: sliced,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Failed", details: err.message });
  }
});

module.exports = router;