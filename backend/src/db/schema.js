const SCHEMA = process.env.DB_SCHEMA || "zeam_platform";

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(SCHEMA)) {
  throw new Error("Invalid DB_SCHEMA");
}

function table(name) {
  return `"${SCHEMA}"."${name}"`;
}

module.exports = { SCHEMA, table };