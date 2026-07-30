# Security Policy

## Reporting a vulnerability

Report vulnerabilities through a private GitHub Security Advisory. Do not publish credentials, access tokens, refresh tokens, authorization codes or callback URLs, client secrets, device codes, private request content, or reproducible exploit details in a public issue.

## Credential handling

The connector supports:

- AWS Builder ID device authorization through `/login kiro`
- AWS IAM Identity Center authorization through `/login kiro`
- Kiro API keys through `/login kiro`
- `KIRO_API_KEY` in the Pi process environment

The connector does not create its own credential file. Pi stores the selected provider credential in its normal credential store and refreshes OAuth access tokens before expiry. An AWS account credential includes the access token, refresh token, dynamically registered OIDC client ID and client secret, authentication region, machine identifier, identity-provider metadata, and an optional Kiro profile ARN. An IAM Identity Center credential also stores the normalized AWS Access Portal Start URL. Protect Pi's configuration directory and do not share its authentication file.

A Kiro API key may use `ksk_...|region`; the connector separates the region before constructing the `Authorization` header. Regions, profile ARNs, machine identifiers, Start URLs, callbacks, and provider-owned routing metadata are validated before use. Internal routing headers contain only request-time routing data, are consumed by the connector, and are not forwarded upstream. They do not contain refresh tokens, registered client secrets, identity-provider type, or the company Start URL.

Commands, tools, model caches, and normal status output do not include credentials or company Start URLs. Upstream error text is bounded and known credential values are redacted before it is surfaced. Do not include API keys, OAuth tokens, callback URLs, authorization codes, registered client secrets, device codes, or Pi authentication files in logs, screenshots, issues, or source control.

## IAM Identity Center login security

IAM Identity Center login accepts only normalized `https://<name>.awsapps.com/start` portal URLs. It dynamically registers a public OIDC client and uses an authorization-code flow with PKCE S256 and a random `state`. Completion accepts exactly one `code` and one matching `state` on the fixed `http://127.0.0.1/oauth/callback` address; arbitrary callback hosts, ports, credentials, fragments, and duplicate security parameters are rejected.

The loopback redirect can show a browser connection error because the connector does not open a local listener. Copying the full callback URL into Pi exposes a short-lived authorization code to the Pi process, so treat the URL as sensitive and do not share or retain it.

## Network and data flow

AWS account login contacts AWS OIDC endpoints at `https://oidc.<auth-region>.amazonaws.com/` for client registration, authorization, token exchange, and refresh. Builder ID additionally uses AWS device authorization. API-key inference uses `https://runtime.<region>.kiro.dev/`. AWS account inference, profile discovery, and model discovery use Kiro account data-plane endpoints, including regional `q.<region>.amazonaws.com` and CodeWhisperer endpoints.

The IAM Identity Center SSO Region controls only OIDC authentication and is not trusted as a Kiro data-plane region. The Kiro data plane is selected separately from a strictly validated profile ARN or a supported default.

Conversation messages, tool definitions, tool results, and images required for inference are transmitted to Kiro services. Pi's provider model cache contains model metadata only; it does not contain credentials, company Start URLs, conversations, images, or tool results.

## Extension trust

Pi extensions execute with the user's permissions. Review the source and package contents before installation, pin releases when appropriate, and install only from a repository or npm package you trust.
