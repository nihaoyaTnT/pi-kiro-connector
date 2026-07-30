# Changelog

All notable changes to this project will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-30

### Added
- Independent `kiro` Provider that calls Kiro's regional Runtime directly.
- Kiro API-key setup through `/login kiro`, `KIRO_API_KEY`, and `KIRO_REGION`.
- Native Pi-to-Kiro message, image, tool, and tool-result translation.
- Incremental AWS EventStream decoding with CRC and truncation validation.
- Streaming text, reasoning, usage, tool calls, cancellation, and sanitized errors.
- Native regional model discovery with Pi model-store caching and offline fallbacks.
- `/kiro-status`, `/kiro-use`, and the `kiro_connection` agent tool.
- English and Simplified Chinese documentation, security guidance, tests, and CI.
- Node.js 20, 22, and 24 validation coverage.

### Independence
- No Kiro-Go process, local HTTP gateway, or Anthropic-compatible proxy is required.
- Kiro-Go is not a runtime or package dependency; its MIT-licensed protocol research is acknowledged in `THIRD_PARTY_NOTICES.md`.
