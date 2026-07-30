# Security Policy

## Reporting a vulnerability

Report vulnerabilities through a private GitHub Security Advisory. Do not publish credentials, access tokens, refresh tokens, client secrets, device codes, private request content, or reproducible exploit details in a public issue.

## Credential handling

The connector supports:

- AWS Builder ID device authorization through `/login kiro`
- Kiro API keys through `/login kiro`
- `KIRO_API_KEY` in the Pi process environment

The connector does not create its own credential file. Pi stores the selected provider credential in its normal credential store. A Builder ID credential includes the access token, refresh token, dynamically registered OIDC client ID and client secret, authentication region, machine identifier, and an optional Kiro profile ARN. Pi refreshes the access token before expiry. Protect Pi's configuration directory and do not share its authentication file.

A Kiro API key may use `ksk_...|region`; the connector separates the region before constructing the `Authorization` header. Regions, profile ARNs, machine identifiers, and provider-owned routing metadata are validated before use. Internal routing headers are consumed by the connector and are not forwarded upstream.

Commands, tools, model caches, and normal status output do not include credentials. Upstream error text is bounded and known credential values are redacted before it is surfaced. Do not include API keys, OAuth tokens, registered client secrets, device codes, or Pi authentication files in logs, screenshots, issues, or source control.

## Network and data flow

Builder ID login contacts AWS OIDC endpoints at `https://oidc.<auth-region>.amazonaws.com/` for client registration, device authorization, and token refresh. API-key inference uses `https://runtime.<region>.kiro.dev/`. Builder ID inference and model discovery use the Kiro account data plane selected from the account profile when available, including regional `q.<region>.amazonaws.com` and CodeWhisperer endpoints.

Conversation messages, tool definitions, tool results, and images required for inference are transmitted to those services. Pi's provider model cache contains model metadata only; it does not contain credentials, conversations, images, or tool results.

## Extension trust

Pi extensions execute with the user's permissions. Review the source and package contents before installation, pin releases when appropriate, and install only from a repository or npm package you trust.
