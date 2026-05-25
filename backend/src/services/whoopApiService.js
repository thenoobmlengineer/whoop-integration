// src/services/whoopApiService.js
const axios = require("axios");

const WHOOP_BASE = "https://api.prod.whoop.com/developer/v2";

/**
 * Create WHOOP API client
 */
function client(accessToken) {
  return axios.create({
    baseURL: WHOOP_BASE,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

/**
 * Helper to clean undefined params
 */
function cleanParams(params = {}) {
  const cleaned = {};
  for (const key of Object.keys(params)) {
    if (params[key] !== undefined && params[key] !== null) {
      cleaned[key] = params[key];
    }
  }
  return cleaned;
}

/* =========================
   PROFILE
========================= */

exports.getProfile = async (accessToken) => {
  const resp = await client(accessToken).get("/user/profile/basic");
  return resp.data;
};

/* =========================
   COLLECTION ENDPOINTS
========================= */

// Sleeps
exports.getSleeps = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get(
    "/activity/sleep",
    { params: cleanParams(params) }
  );
  return resp.data;
};

// Workouts
exports.getWorkouts = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get(
    "/activity/workout",
    { params: cleanParams(params) }
  );
  return resp.data;
};

// Recoveries
exports.getRecoveries = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get(
    "/recovery",
    { params: cleanParams(params) }
  );
  return resp.data;
};

// Cycles
exports.getCycles = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get(
    "/cycle",
    { params: cleanParams(params) }
  );
  return resp.data;
};

/* =========================
   DETAIL ENDPOINTS (USED BY WEBHOOK)
========================= */

// Workout detail
exports.getWorkoutById = async (accessToken, workoutId) => {
  const resp = await client(accessToken).get(
    `/activity/workout/${workoutId}`
  );
  return resp.data;
};

// Sleep detail
exports.getSleepById = async (accessToken, sleepId) => {
  const resp = await client(accessToken).get(
    `/activity/sleep/${sleepId}`
  );
  return resp.data;
};

// Recovery detail
exports.getRecoveryById = async (accessToken, recoveryId) => {
  const resp = await client(accessToken).get(
    `/recovery/${recoveryId}`
  );
  return resp.data;
};

// Cycle detail
exports.getCycleById = async (accessToken, cycleId) => {
  const resp = await client(accessToken).get(
    `/cycle/${cycleId}`
  );
  return resp.data;
};