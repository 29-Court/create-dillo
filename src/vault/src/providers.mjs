// Dillo Vault — provider registry (public configuration, NOT secrets).
// Endpoints and scopes are public config; the Vault row holds only the
// credential pair (clientId + clientSecret) + the exact registered
// redirect_uri, sealed like any other secret. A real grant needs a real
// client + consent = the owner's act (plan §6 R-8); until then the
// dance runs against MOCK grants (fixtures below), never a real provider.
export const PROVIDERS = {
  // TB-1 (Tranche B): the preview stack's external counterparty
  // fixture — a real OAuth2 authorization server (authorize → code →
  // token → userinfo, PKCE S256) living at
  // ops/preview/fixtures/oauth-test-provider/. It is NOT a double of
  // any house component: the Vault dance runs against it over HTTP
  // exactly as against Google. Live only where the fixture is
  // deployed/configured; elsewhere oauth.start refuses by name
  // (app-not-registered until the oauth-app:test row is saved).
  // TB-2c (Tranche B): the fixture is reached on its ROUTED hostname
  // (oauth-test.hackthedillo.dev, a Workers custom domain on the
  // non-production hackthedillo.dev zone, attached by stand_up.py),
  // NOT its workers.dev URL — a Worker cannot fetch another Worker's
  // workers.dev URL in the same account (Cloudflare error 1042,
  // proven live in TB-2b: the ceremony stood complete through
  // CONSENT, then the token exchange 404'd). The fixture serves the
  // same code on both hosts; only the Vault's server-side fetches
  // (token + userinfo) require the routed host.
  test: {
    provider: "test",
    authorizeUrl: "https://oauth-test.hackthedillo.dev/authorize",
    tokenUrl: "https://oauth-test.hackthedillo.dev/token",
    userinfoUrl: "https://oauth-test.hackthedillo.dev/userinfo",
    tokenHost: "oauth-test.hackthedillo.dev",
    pkce: "S256",
    defaultScopes: ["openid", "email", "profile"],
  },
  google: {
    provider: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    tokenHost: "oauth2.googleapis.com",
    pkce: "S256",
    defaultScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  },
};

export function getProvider(name) {
  return PROVIDERS[name] || null;
}

// Mock-grant provider (fixture only, never live). Answers the token
// endpoint and userinfo with fixture values supplied by the test. Performs
// no network call. Enabled ONLY when the worker runs with
// VAULT_TEST_DOUBLE=1 (local proof) or a test injects it directly.
// A REAL grant is the owner's act; this never claims to be one.
export function makeTestDoubleProvider({ tokenResponse, userinfoResponse } = {}) {
  return {
    isTestDouble: true,
    tokenResponse: tokenResponse || {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: (PROVIDERS.google.defaultScopes || []).join(" "),
    },
    userinfoResponse: userinfoResponse || { email: "vault-mock@example.test", name: "Vault Mock" },
  };
}
