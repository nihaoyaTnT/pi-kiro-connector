# Security Policy

## Reporting a vulnerability

Report vulnerabilities through a private GitHub Security Advisory after the repository is available. Do not publish credentials, access tokens, private request content, or reproducible exploit details in a public issue.

## Credential handling

The connector supports two credential sources:

- Pi's provider credential store, configured with `/login kiro`
- `KIRO_API_KEY` in the Pi process environment

The connector does not create its own credential file. Pi may persist a key entered through `/login`; consult Pi's security documentation and protect its configuration directory accordingly. Commands, tools, model caches, and normal error messages do not include the key. Upstream error text is bounded and exact key values are redacted before it is surfaced.

A key may use `ksk_...|region`; the connector separates the region before constructing the `Authorization` header. `KIRO_REGION` and embedded region values are validated as DNS-safe region labels before use.

## Network and data flow

Inference requests are sent directly to `https://runtime.<region>.kiro.dev/`. Model discovery uses the regional CodeWhisperer model-catalog endpoint. Conversation messages, tool definitions, tool results, and images required for inference are transmitted to those services. The project does not operate an intermediary server.

Pi's provider model cache contains model metadata only. It does not contain credentials, conversations, images, or tool results.

## Extension trust

Pi extensions execute with the user's permissions. Review the source and package contents before installation, pin releases when appropriate, and install only from a repository or npm package you trust.
