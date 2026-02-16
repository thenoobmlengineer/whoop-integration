const express = require("express");
const router = express.Router();

const { whoopWebhook } = require("../controllers/webhookController");

router.post("/whoop", whoopWebhook);

module.exports = router;
