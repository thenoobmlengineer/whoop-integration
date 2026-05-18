const express = require("express");
const router = express.Router();

const { getByAppUserId } = require("../repositories/whoopConnectionRepo");
const { backfill, getSummary, disconnect, } = require("../controllers/whoopController");

// optional quick check
router.get("/health", (req, res) => {
  res.json({ ok: true, service: "whoop-routes" });
});

// MVP: allow app_user_id via query for now (Option B)
router.get("/connection", async (req, res) => {
  try {
    const appUserId = (req.query.app_user_id || "").trim();
    if (!appUserId) {
      return res.status(400).json({ ok: false, error: "Missing app_user_id" });
    }

    const row = await getByAppUserId(appUserId);
    if (!row) {
      return res.status(404).json({ ok: false, error: "No WHOOP connection found" });
    }

    // Do NOT return tokens
    return res.json({
      ok: true,
      connected: true,
      app_user_id: row.app_user_id,
      whoop_user_id: row.whoop_user_id,
      scopes: row.scopes,
      expires_at: row.expires_at,
      updated_at: row.updated_at,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Backfill past data into DB
router.get("/summary", getSummary);
router.post("/backfill", backfill);
router.post("/disconnect", disconnect);

module.exports = router;
