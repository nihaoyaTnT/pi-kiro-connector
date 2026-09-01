# pi-kiro-connector

A [Pi](https://pi.dev) package that adds native Kiro Runtime access with model discovery, streaming, reasoning, images, and tools.

[简体中文](README.zh-CN.md)

## Features

- Provides a dedicated `kiro` provider for every compatible model returned by Kiro's model catalog
- Calls the regional Kiro Runtime and decodes AWS EventStream responses
- Supports streaming text, reasoning, images, Pi tools, tool results, and cancellation
- Discovers models and token limits from Kiro's regional model catalog
- Provides a built-in fallback catalog for offline startup
- Supports AWS Builder ID and AWS IAM Identity Center (company SSO) sign-in with automatic token refresh through `/login kiro`
- Supports Kiro API keys through `/login kiro` or `KIRO_API_KEY`
- Adds `/kiro-status`, `/kiro-use`, and the LLM-callable `kiro_connection` tool
- Never returns or intentionally logs credentials
- Has no runtime npm dependencies beyond Pi's package peers

## Requirements

1. Node.js 22.19.0 or newer
2. Pi 0.84.4 or newer
3. An AWS Builder ID or IAM Identity Center account authorized for Kiro, or a Kiro API key typically beginning with `ksk_`

Use only credentials and services you are authorized to access.

## Install

From GitHub:

```bash
pi install git:github.com/nihaoyaTnT/pi-kiro-connector
```

Pin a release for reproducible installation:

```bash
pi install git:github.com/nihaoyaTnT/pi-kiro-connector@v0.1.0
```

From npm after publication:

```bash
pi install npm:pi-kiro-connector@0.1.0
```

For local development:

```bash
git clone https://github.com/nihaoyaTnT/pi-kiro-connector.git
cd pi-kiro-connector
npm ci
pi install .
```

## Configure

### Recommended: Pi login

Start Pi and run:

```text
/login kiro
```

Pi offers account sign-in or API-key authentication. Account sign-in then lets you choose:

- **AWS Builder ID** — Pi displays a device code and an AWS verification URL. Sign in with the account you use for Kiro and approve the request.
- **AWS IAM Identity Center** — for a company AWS Access Portal. Enter the portal Start URL (for example, `https://company.awsapps.com/start`) and its SSO Region. Complete company SSO in the browser. The browser will redirect to `http://127.0.0.1/oauth/callback`; a local server is not required, so copy the full URL from the address bar and paste it into Pi when prompted.
- **Kiro API key** — enter `ksk_...` or `ksk_...|region` in the API-key login option.

Pi stores the selected credential in its normal provider credential store and refreshes OAuth access tokens automatically. Only one stored credential is active for the `kiro` provider; running `/login kiro` again replaces it. The connector does not create a separate credential file.

The IAM Identity Center SSO Region is the region shown in your company's AWS access-portal configuration. It is used only for AWS OIDC authentication; the connector selects the Kiro data-plane region separately from the account's Kiro profile.

### Environment variables

Alternatively, configure the process before starting Pi.

PowerShell:

```powershell
$env:KIRO_API_KEY = "ksk_..."
$env:KIRO_REGION = "us-east-1"
pi
```

Windows Command Prompt:

```bat
set KIRO_API_KEY=ksk_...
set KIRO_REGION=us-east-1
pi
```

Linux and macOS:

```bash
export KIRO_API_KEY='ksk_...'
export KIRO_REGION='us-east-1'
pi
```

`KIRO_REGION` defaults to `us-east-1`. You may instead append the region to the key, for example `KIRO_API_KEY='ksk_...|eu-central-1'`. An explicit `KIRO_REGION` takes precedence over the appended value.

Do not put API keys, OAuth tokens, authorization callback URLs/codes, device codes, registered client secrets, or Pi authentication files in source control, issue reports, screenshots, or shell history shared with others.

## Use

Reload Pi after installation, then check and select the provider:

```text
/reload
/kiro-status
/kiro-use claude-sonnet-4.6
```

Or select a model at startup:

```bash
pi --provider kiro --model claude-sonnet-4.6
```

The `kiro_connection` tool supports:

- `status` — check authentication, regional connectivity, and model discovery
- `models` — list registered Kiro model IDs
- `use` — switch to a Kiro model

The status command and tool report only the credential source, endpoint, status, and model count. They do not return API keys or OAuth tokens.

## How it works

The connector translates Pi messages into Kiro's native conversation format. API-key requests use the regional Kiro Runtime:

```text
https://runtime.<region>.kiro.dev/
```

AWS Builder ID uses AWS OIDC device authorization. IAM Identity Center uses the company's AWS Access Portal issuer with an authorization-code flow protected by PKCE and `state`. Pi stores the access token, refresh token, registered client metadata, authentication metadata, and optional Kiro profile ARN as one OAuth credential; access tokens are refreshed before expiry. Neither the identity-provider type nor the company Start URL is forwarded in inference requests.

Model metadata is discovered through the account's regional model-catalog operation. Responses use bounded, idle-timed AWS EventStream framing; the connector incrementally validates frame CRCs and maps text, reasoning, usage, and interleaved tool events into Pi's native stream protocol. Model discovery and pre-stream requests use bounded responses, timeouts, and limited retries for transient failures.

Pi controls reasoning through `/settings`, Shift+Tab, or `--thinking`. The connector adds Kiro's reasoning prompt only when a Pi reasoning level is enabled. Kiro's current protocol is treated as an on/off control, so `minimal` through `max` currently produce the same enabled behavior.

Pi caches a successfully discovered model catalog through its provider model store. The stored catalog contains model metadata only. A small static catalog keeps the provider visible during offline startup.

## Troubleshooting

### Authentication fails

Run `/login kiro` again. For Builder ID, complete device authorization with the account you use for Kiro. For IAM Identity Center, verify the exact AWS Access Portal Start URL and SSO Region with your administrator, and paste the complete loopback callback URL into Pi. For API-key authentication, verify that `KIRO_API_KEY` contains a valid Kiro API key. `/kiro-status` reports authentication failures without displaying credentials.

### The regional endpoint fails

For API-key authentication, verify `KIRO_REGION`; it must be a region label such as `us-east-1` or `eu-central-1`. AWS account authentication chooses its Kiro data-plane region from the account profile when available. An IAM Identity Center SSO Region is an authentication setting and is not used as the Kiro data-plane region.

### Models are not refreshed

Run `/reload` or restart Pi with network access and a configured credential. If discovery is unavailable, Pi retains cached metadata or uses the built-in fallback list.

### Package changes are not visible

```bash
pi list
pi config
```

Then run `/reload` or restart Pi.

## Development

```bash
npm ci
npm run validate
```

Validation runs TypeScript checks, protocol/unit tests, an offline Pi loading smoke test, and `npm pack --dry-run`. CI runs the suite on Node.js 22.19.0 and 24.

## Security and privacy

Requests contain the conversation context needed for inference and are sent to Kiro's regional services. See [SECURITY.md](SECURITY.md) for credential handling, reporting, and review guidance.

## License

This project is licensed under [MIT](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
