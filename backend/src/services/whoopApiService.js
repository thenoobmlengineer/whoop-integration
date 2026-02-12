const axios = require("axios");

const WHOOP_BASE = "https://api.prod.whoop.com/developer/v2";

function client(accessToken) {
  return axios.create({
    baseURL: WHOOP_BASE,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

// Profile
exports.getProfile = async (accessToken) => {
  const resp = await client(accessToken).get("/user/profile/basic");
  return resp.data;
};

// Sleeps (collection)
exports.getSleeps = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get("/activity/sleep", { params });
  return resp.data;
};

// Recovery (collection)
exports.getRecoveries = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get("/recovery", { params });
  return resp.data;
};

// Cycles (collection)
exports.getCycles = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get("/cycle", { params });
  return resp.data;
};

// Workouts (collection)
exports.getWorkouts = async (accessToken, params = {}) => {
  const resp = await client(accessToken).get("/activity/workout", { params });
  return resp.data;
};
