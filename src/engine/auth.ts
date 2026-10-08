import { normalizeEmail, scopeAllows, authInput, parseProfile, profileAssignments, readProfileAssignment, profileConflict } from "./auth/credentials.js";
import { externalAuthProvider, externalAuth, requireAuth, optionalAuth, requireUserSession, requireAdminKey, enforceRateLimit, safeRedirect, configuredBootstrapSecret, MIN_ADMINISTRATIVE_SECRET_LENGTH, assertAdministrativeSecretStrength, bootstrapSecretMatches, declaredUserFields, assertOwnedProfileFiles, profileJsonForCreate, signUp, logIn, changePassword, resetUserPassword, renameUser, createUserForAdministration } from "./auth/sessions.js";
import { bootstrapSuperadmin } from "./auth/bootstrap.js";
import { authRoute } from "./auth/routes.js";

export {
  normalizeEmail,
  authInput,
  scopeAllows,
  externalAuthProvider,
  externalAuth,
  requireAuth,
  optionalAuth,
  requireUserSession,
  requireAdminKey,
  enforceRateLimit,
  safeRedirect,
  configuredBootstrapSecret,
  MIN_ADMINISTRATIVE_SECRET_LENGTH,
  assertAdministrativeSecretStrength,
  bootstrapSecretMatches,
  bootstrapSuperadmin,
  parseProfile,
  declaredUserFields,
  profileAssignments,
  readProfileAssignment,
  assertOwnedProfileFiles,
  profileConflict,
  profileJsonForCreate,
  signUp,
  logIn,
  changePassword,
  resetUserPassword,
  renameUser,
  createUserForAdministration,
  authRoute,
};
