function isRealtimeChannel(value) {
  return /^(?:table:[A-Za-z][A-Za-z0-9_-]{0,62}|[a-z][a-z0-9_.:-]{0,95})$/.test(value);
}
function serializeRealtimeMessage(message) {
  return JSON.stringify(message);
}
function matchesRealtimeWhere(record, where) {
  if (!where) return true;
  return Object.entries(where).every(([field, value]) => Object.is(record[field], value));
}
export {
  isRealtimeChannel,
  matchesRealtimeWhere,
  serializeRealtimeMessage
};
