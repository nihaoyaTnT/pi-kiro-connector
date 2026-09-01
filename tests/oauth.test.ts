import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
  accountAuthHeaders,
  accountRequestAuth,
  builderIdAuthHeaders,
  builderIdRequestAuth,
  INTERNAL_AUTH_TYPE,
  requestAuthFromOptions,
  type KiroBuilderIdCredential,
  type KiroIdentityCenterCredential,
} from "../src/auth.ts";
import {
  completeBuilderIdAuthorization,
  completeIdentityCenterAuthorization,
  refreshBuilderId,
  refreshKiroOAuth,
  startBuilderIdAuthorization,
  startIdentityCenterAuthorization,
} from "../src/oauth.ts";
import { createKiroProvider } from "../src/provider.ts";

const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";
const signal = new AbortController().signal;

function builderCredential(): KiroBuilderIdCredential {
  return {
    type: "oauth",
    access: "account_access_token",
    refresh: "account_refresh_token",
    expires: Date.now() + 3_600_000,
    authRegion: "us-east-1",
    clientId: "registered_client_id",
    clientSecret: "registered_client_secret",
    machineId: "12345678-1234-4234-8234-123456789abc",
    profileArn,
    identityProvider: "builder_id",
  };
}

test("starts and completes the Builder ID device authorization flow", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let tokenPolls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/client/register")) {
      return Response.json({ clientId: "client_id", clientSecret: "client_secret" });
    }
    if (url.endsWith("/device_authorization")) {
      return Response.json({
        deviceCode: "device_secret",
        userCode: "ABCD-EFGH",
        verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
        interval: 1,
        expiresIn: 600,
      });
    }
    tokenPolls++;
    return Response.json({
      accessToken: "access_secret",
      refreshToken: "refresh_secret",
      expiresIn: 3600,
      profileArn,
    });
  };

  const authorization = await startBuilderIdAuthorization({ fetch: fetcher });
  assert.equal(authorization.userCode, "ABCD-EFGH");
  assert.equal(authorization.authRegion, "us-east-1");
  const credential = await completeBuilderIdAuthorization(authorization, { fetch: fetcher });

  assert.equal(tokenPolls, 1);
  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, "access_secret");
  assert.equal(credential.refresh, "refresh_secret");
  assert.equal(credential.clientId, "client_id");
  assert.equal(credential.clientSecret, "client_secret");
  assert.equal(credential.profileArn, profileArn);
  assert.match(credential.machineId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/client/register",
    "/device_authorization",
    "/token",
  ]);
  assert.equal(calls[0]?.body.clientType, "public");
});

test("discovers a regional Kiro profile when the token response omits it", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, headers: new Headers(init?.headers), body });
    if (url.endsWith("/client/register")) {
      return Response.json({ clientId: "client_id", clientSecret: "client_secret" });
    }
    if (url.endsWith("/device_authorization")) {
      return Response.json({
        deviceCode: "device_secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
        interval: 1,
        expiresIn: 600,
      });
    }
    if (url.endsWith("/token")) {
      return Response.json({
        accessToken: "access_secret",
        refreshToken: "refresh_secret",
        expiresIn: 3600,
      });
    }
    if (url.startsWith("https://codewhisperer.us-east-1.amazonaws.com/")) {
      return Response.json({ profiles: [] });
    }
    return Response.json({ profiles: [{ arn: profileArn, profileName: "Kiro" }] });
  };

  const authorization = await startBuilderIdAuthorization({ fetch: fetcher });
  const credential = await completeBuilderIdAuthorization(authorization, { fetch: fetcher });

  assert.equal(credential.profileArn, profileArn);
  assert.deepEqual(
    requests.slice(-2).map((request) => request.url),
    [
      "https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles",
      "https://q.eu-central-1.amazonaws.com/ListAvailableProfiles",
    ],
  );
  assert.equal(requests.at(-1)?.headers.get("authorization"), "Bearer access_secret");
  assert.deepEqual(requests.at(-1)?.body, { maxResults: 50 });
});

test("rejects an untrusted Builder ID verification URL", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/client/register")) {
      return Response.json({ clientId: "client_id", clientSecret: "client_secret" });
    }
    return Response.json({
      deviceCode: "device_secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.invalid/capture",
      interval: 1,
      expiresIn: 600,
    });
  };

  await assert.rejects(startBuilderIdAuthorization({ fetch: fetcher }), /invalid verification URL/i);
});

test("refreshes Builder ID tokens and preserves rotated credential metadata", async () => {
  let sent: Record<string, unknown> | undefined;
  const refreshed = await refreshBuilderId(
    builderCredential(),
    undefined,
    async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        accessToken: "new_access",
        refreshToken: "new_refresh",
        expiresIn: 1800,
      });
    },
  );

  assert.deepEqual(sent, {
    clientId: "registered_client_id",
    clientSecret: "registered_client_secret",
    refreshToken: "account_refresh_token",
    grantType: "refresh_token",
  });
  assert.equal(refreshed.access, "new_access");
  assert.equal(refreshed.refresh, "new_refresh");
  assert.equal(refreshed.profileArn, profileArn);
  assert.equal(refreshed.machineId, builderCredential().machineId);
});

test("does not replay OAuth token refresh after a network failure", async () => {
  let calls = 0;
  await assert.rejects(
    refreshBuilderId(builderCredential(), undefined, async () => {
      calls++;
      throw new Error("token exchange connection lost");
    }),
    /token exchange connection lost/,
  );
  assert.equal(calls, 1);
});

test("encodes only non-refresh Builder ID metadata for the local stream adapter", async () => {
  const credential = builderCredential();
  const headers = builderIdAuthHeaders(credential);
  const serialized = JSON.stringify(headers);
  assert.equal(headers[INTERNAL_AUTH_TYPE], "account");
  assert.doesNotMatch(serialized, /account_refresh_token|registered_client_secret/);

  const decoded = requestAuthFromOptions(credential.access, undefined, headers);
  assert.deepEqual(decoded, builderIdRequestAuth(credential));

  const provider = createKiroProvider();
  const auth = await provider.auth.oauth?.toAuth(credential);
  assert.equal(auth?.apiKey, credential.access);
  assert.doesNotMatch(JSON.stringify(auth?.headers), /account_refresh_token|registered_client_secret/);
});

test("completes IAM Identity Center authorization with PKCE and discovers a profile", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body, headers: new Headers(init?.headers) });
    if (url.endsWith("/client/register")) {
      return Response.json({ clientId: "enterprise_client", clientSecret: "enterprise_secret" });
    }
    if (url.endsWith("/token")) {
      return Response.json({
        accessToken: "enterprise_access",
        refreshToken: "enterprise_refresh",
        expiresIn: 1800,
      });
    }
    if (url.startsWith("https://codewhisperer.us-east-1.amazonaws.com/")) {
      return Response.json({ profiles: [] });
    }
    return Response.json({ profiles: [{ arn: profileArn, profileName: "Company Kiro" }] });
  };

  const authorization = await startIdentityCenterAuthorization({
    startUrl: " HTTPS://Company.awsapps.com/start/ ",
    region: "AP-SOUTHEAST-2",
    fetch: fetcher,
  });
  const authorizeUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorization.startUrl, "https://company.awsapps.com/start");
  assert.equal(authorization.authRegion, "ap-southeast-2");
  assert.equal(authorizeUrl.origin, "https://oidc.ap-southeast-2.amazonaws.com");
  assert.equal(authorizeUrl.pathname, "/authorize");
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "http://127.0.0.1/oauth/callback");
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizeUrl.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[0]?.body.issuerUrl, "https://company.awsapps.com/start");
  assert.deepEqual(requests[0]?.body.grantTypes, ["authorization_code", "refresh_token"]);
  assert.deepEqual(requests[0]?.body.redirectUris, ["http://127.0.0.1/oauth/callback"]);

  const credential = await completeIdentityCenterAuthorization(
    authorization,
    `http://127.0.0.1/oauth/callback?code=company_code&state=${encodeURIComponent(authorization.state)}`,
    { fetch: fetcher },
  );

  assert.equal(credential.identityProvider, "iam_identity_center");
  assert.equal(credential.startUrl, "https://company.awsapps.com/start");
  assert.equal(credential.access, "enterprise_access");
  assert.equal(credential.refresh, "enterprise_refresh");
  assert.equal(credential.profileArn, profileArn);
  assert.match(credential.machineId, /^[0-9a-f-]{36}$/);
  const exchange = requests.find((request) => request.url.endsWith("/token"));
  assert.deepEqual(exchange?.body, {
    clientId: "enterprise_client",
    clientSecret: "enterprise_secret",
    grantType: "authorization_code",
    redirectUri: "http://127.0.0.1/oauth/callback",
    code: "company_code",
    codeVerifier: authorization.codeVerifier,
  });
  const profileRequests = requests.filter((request) => request.url.endsWith("/ListAvailableProfiles"));
  assert.deepEqual(profileRequests.map((request) => request.url), [
    "https://q.ap-southeast-2.amazonaws.com/ListAvailableProfiles",
  ]);
  assert.equal(profileRequests[0]?.headers.get("authorization"), "Bearer enterprise_access");
});

test("rejects unsafe IAM Identity Center input and mismatched callbacks", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({ clientId: "enterprise_client", clientSecret: "enterprise_secret" });

  await assert.rejects(
    startIdentityCenterAuthorization({
      startUrl: "https://company.awsapps.com.evil.example/start",
      region: "us-east-1",
      fetch: fetcher,
    }),
    /invalid AWS Access Portal Start URL/i,
  );
  await assert.rejects(
    startIdentityCenterAuthorization({
      startUrl: "https://company.awsapps.com/start",
      region: "us-east-1",
      fetch: async () =>
        new Response(
          '{"message":"issuer https://company.awsapps.com/start was rejected"}',
          { status: 400 },
        ),
    }),
    (error: unknown) => {
      assert.match(String(error), /HTTP 400/);
      assert.match(String(error), /\[REDACTED\]/);
      assert.doesNotMatch(String(error), /company\.awsapps\.com/);
      return true;
    },
  );

  const authorization = await startIdentityCenterAuthorization({
    startUrl: "https://company.awsapps.com/start",
    region: "us-east-1",
    fetch: fetcher,
  });
  await assert.rejects(
    completeIdentityCenterAuthorization(
      authorization,
      `http://localhost/oauth/callback?code=secret_code&state=${authorization.state}`,
      { fetch: async () => { throw new Error("must not exchange an unsafe callback"); } },
    ),
    /invalid IAM Identity Center callback URL/i,
  );
  await assert.rejects(
    completeIdentityCenterAuthorization(
      authorization,
      "http://127.0.0.1/oauth/callback?code=secret_code&state=wrong",
      { fetch: async () => { throw new Error("must not exchange a mismatched callback"); } },
    ),
    /state did not match/i,
  );
  await assert.rejects(
    completeIdentityCenterAuthorization(
      authorization,
      `http://127.0.0.1/oauth/callback?code=one&code=two&state=${authorization.state}`,
      { fetch: async () => { throw new Error("must not exchange an ambiguous callback"); } },
    ),
    /omitted the authorization code/i,
  );
  await assert.rejects(
    completeIdentityCenterAuthorization(
      authorization,
      `http://127.0.0.1/oauth/callback?error=sensitive_callback_detail&state=${authorization.state}`,
      { fetch: async () => { throw new Error("must not exchange an error callback"); } },
    ),
    (error: unknown) => {
      assert.match(String(error), /authorization failed/i);
      assert.doesNotMatch(String(error), /sensitive_callback_detail/);
      return true;
    },
  );
});

test("refreshes IAM Identity Center credentials without changing account metadata", async () => {
  const credential: KiroIdentityCenterCredential = {
    type: "oauth",
    access: "enterprise_access",
    refresh: "enterprise_refresh",
    expires: Date.now() - 1,
    authRegion: "eu-west-1",
    startUrl: "https://company.awsapps.com/start",
    clientId: "enterprise_client",
    clientSecret: "enterprise_secret",
    machineId: "12345678-1234-4234-8234-123456789abc",
    profileArn,
    identityProvider: "iam_identity_center",
  };
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const refreshed = await refreshKiroOAuth(credential, undefined, async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ accessToken: "enterprise_access_2", expiresIn: 3600 });
  });

  assert.equal(requestUrl, "https://oidc.eu-west-1.amazonaws.com/token");
  assert.deepEqual(requestBody, {
    clientId: "enterprise_client",
    clientSecret: "enterprise_secret",
    refreshToken: "enterprise_refresh",
    grantType: "refresh_token",
  });
  assert.equal(refreshed.identityProvider, "iam_identity_center");
  assert.equal(refreshed.startUrl, credential.startUrl);
  assert.equal(refreshed.refresh, credential.refresh);
  assert.equal(refreshed.access, "enterprise_access_2");
});

test("encodes enterprise account routing without exposing identity or refresh metadata", async () => {
  const credential: KiroIdentityCenterCredential = {
    type: "oauth",
    access: "enterprise_access",
    refresh: "enterprise_refresh",
    expires: Date.now() + 3_600_000,
    authRegion: "us-east-1",
    startUrl: "https://company.awsapps.com/start",
    clientId: "enterprise_client",
    clientSecret: "enterprise_secret",
    machineId: "12345678-1234-4234-8234-123456789abc",
    profileArn,
    identityProvider: "iam_identity_center",
  };
  const headers = accountAuthHeaders(credential);
  assert.equal(headers[INTERNAL_AUTH_TYPE], "account");
  assert.deepEqual(requestAuthFromOptions(credential.access, undefined, headers), accountRequestAuth(credential));
  assert.doesNotMatch(
    JSON.stringify(headers),
    /enterprise_(?:refresh|secret|client)|iam_identity_center|awsapps/i,
  );
  const providerAuth = await createKiroProvider().auth.oauth?.toAuth(credential);
  assert.equal(providerAuth?.apiKey, "enterprise_access");
  assert.equal(providerAuth?.headers?.[INTERNAL_AUTH_TYPE], "account");
  assert.doesNotMatch(JSON.stringify(providerAuth?.headers), /enterprise_refresh|enterprise_secret|awsapps/i);
});

test("the provider drives the IAM Identity Center login prompts without exposing secrets", async () => {
  const promptTypes: string[] = [];
  const displayed: string[] = [];
  let callbackState = "";
  const interaction: ProviderAuthInteraction = {
    signal,
    notify(event) {
      displayed.push(JSON.stringify(event));
      if (event.type === "auth_url") {
        callbackState = new URL(event.url).searchParams.get("state") ?? "";
      }
    },
    async prompt(prompt) {
      promptTypes.push(prompt.type);
      if (prompt.type === "select") return "iam_identity_center";
      if (prompt.type === "text" && prompt.message.includes("Start URL")) {
        return "https://company.awsapps.com/start";
      }
      if (prompt.type === "text") return "ap-southeast-2";
      if (prompt.type === "manual_code") {
        assert.ok(callbackState);
        return `http://127.0.0.1/oauth/callback?code=enterprise_code&state=${encodeURIComponent(callbackState)}`;
      }
      throw new Error(`Unexpected prompt type: ${prompt.type}`);
    },
  };
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/client/register")) {
      return Response.json({ clientId: "enterprise_client", clientSecret: "enterprise_secret" });
    }
    if (url.endsWith("/token")) {
      return Response.json({
        accessToken: "enterprise_access",
        refreshToken: "enterprise_refresh",
        expiresIn: 3600,
        profileArn,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const credential = await createKiroProvider().auth.oauth?.login(interaction);
    assert.equal(credential?.identityProvider, "iam_identity_center");
    assert.equal(credential?.authRegion, "ap-southeast-2");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(promptTypes, ["select", "text", "text", "manual_code"]);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/client/register",
    "/token",
  ]);
  const output = displayed.join("\n");
  assert.match(output, /oidc\.ap-southeast-2\.amazonaws\.com\/authorize/);
  assert.doesNotMatch(
    output,
    /enterprise_(?:access|refresh|secret)|enterprise_code|company\.awsapps\.com\/start/i,
  );
});

test("the Builder ID login flow reports a device code without exposing tokens", async () => {
  const events: string[] = [];
  const requests: string[] = [];
  const interaction: ProviderAuthInteraction = {
    signal,
    notify(event) {
      events.push(JSON.stringify(event));
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") return "builder_id";
      throw new Error("Builder ID login must not prompt for account passwords");
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/client/register")) {
      return Response.json({ clientId: "client_id", clientSecret: "client_secret" });
    }
    if (url.endsWith("/device_authorization")) {
      return Response.json({
        deviceCode: "device_secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://device.sso.us-east-1.amazonaws.com/",
        interval: 1,
        expiresIn: 600,
      });
    }
    if (url.endsWith("/ListAvailableProfiles")) {
      return Response.json(
        { message: "AWS Builder ID is not supported for this operation." },
        { status: 403 },
      );
    }
    return Response.json({
      accessToken: "access_secret",
      refreshToken: "refresh_secret",
      expiresIn: 3600,
    });
  };

  try {
    const credential = await createKiroProvider().auth.oauth?.login(interaction);
    assert.equal(credential?.type, "oauth");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const displayed = events.join("\n");
  assert.match(displayed, /ABCD-EFGH/);
  assert.doesNotMatch(displayed, /access_secret|refresh_secret|client_secret|device_secret/);
  assert.deepEqual(requests.map((url) => new URL(url).pathname), [
    "/client/register",
    "/device_authorization",
    "/token",
    "/ListAvailableProfiles",
  ]);
});
