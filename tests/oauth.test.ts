import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  builderIdAuthHeaders,
  builderIdRequestAuth,
  INTERNAL_AUTH_TYPE,
  requestAuthFromOptions,
  type KiroBuilderIdCredential,
} from "../src/auth.ts";
import {
  completeBuilderIdAuthorization,
  refreshBuilderId,
  startBuilderIdAuthorization,
} from "../src/oauth.ts";
import { createKiroProvider } from "../src/provider.ts";

const profileArn = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example";

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

test("encodes only non-refresh Builder ID metadata for the local stream adapter", async () => {
  const credential = builderCredential();
  const headers = builderIdAuthHeaders(credential);
  const serialized = JSON.stringify(headers);
  assert.equal(headers[INTERNAL_AUTH_TYPE], "builder_id");
  assert.doesNotMatch(serialized, /account_refresh_token|registered_client_secret/);

  const decoded = requestAuthFromOptions(credential.access, undefined, headers);
  assert.deepEqual(decoded, builderIdRequestAuth(credential));

  const provider = createKiroProvider();
  const auth = await provider.auth.oauth?.toAuth(credential);
  assert.equal(auth?.apiKey, credential.access);
  assert.doesNotMatch(JSON.stringify(auth?.headers), /account_refresh_token|registered_client_secret/);
});

test("the Builder ID login flow reports a device code without exposing tokens", async () => {
  const events: string[] = [];
  const requests: string[] = [];
  const interaction: AuthInteraction = {
    notify(event) {
      events.push(JSON.stringify(event));
    },
    prompt: async () => {
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
