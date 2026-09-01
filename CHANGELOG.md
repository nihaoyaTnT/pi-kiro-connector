# Changelog

All notable changes to this project will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-30

### Added
- Dedicated `kiro` Provider supporting compatible models from Kiro's regional catalog.
- AWS Builder ID device authorization through `/login kiro`, with persisted OAuth credentials and automatic token refresh.
- AWS IAM Identity Center company SSO through `/login kiro`, using dynamic OIDC registration, PKCE, state validation, strict loopback callback parsing, and automatic token refresh.
- Kiro API-key setup through `/login kiro`, `KIRO_API_KEY`, and `KIRO_REGION`.
- Authentication-aware routing between the API-key Runtime and AWS account data plane.
- Native Pi-to-Kiro message, image, tool, and tool-result translation.
- Incremental AWS EventStream decoding with CRC, truncation, frame-size, and idle-timeout validation.
- Bounded HTTP response reads, paginated model discovery, and operation-aware retries that avoid replaying OAuth exchanges or ambiguous inference failures.
- Pi session-aware upstream conversation IDs and ordered assembly of interleaved tool calls with bounded pending input.
- Streaming text, reasoning, usage, tool calls, cancellation, and sanitized errors.
- Native regional model discovery with Pi model-store caching and offline fallbacks.
- `/kiro-status`, `/kiro-use`, and the `kiro_connection` agent tool.
- English and Simplified Chinese documentation, security guidance, tests, and CI.
- Node.js 22.19.0 and 24 validation coverage, matching Pi 0.84.4's runtime requirement.
