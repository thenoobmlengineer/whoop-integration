const express = require("express");
const router = express.Router();

const { startWhoopAuth, whoopCallback } = require("../controllers/authController");

router.get("/whoop/start", startWhoopAuth);
router.get("/whoop/callback", whoopCallback);

module.exports = router;
