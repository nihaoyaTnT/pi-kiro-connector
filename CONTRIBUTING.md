# Contributing

Contributions are welcome.

## Development

Requirements: Node.js 22.19.0 or newer and Pi 0.83.0 or newer.

```bash
npm ci
npm run validate
```

Try the extension without installing it globally:

```bash
pi --offline --no-extensions -e ./extensions/kiro-connector.ts --list-models kiro
```

For an authorized end-to-end test, either sign in through `/login kiro` with AWS Builder ID or configure a Kiro API key and run:

```bash
KIRO_API_KEY='ksk_...|us-east-1' pi --no-extensions \
  -e ./extensions/kiro-connector.ts \
  --provider kiro --model claude-sonnet-4.6 -p 'Reply with OK'
```

PowerShell users can set `$env:KIRO_API_KEY` and `$env:KIRO_REGION` before starting Pi. Never commit Pi's stored OAuth credential or captured device-authorization responses.

## Pull requests

1. Keep credentials and local configuration out of commits.
2. Add or update tests for protocol and behavior changes.
3. Run `npm run validate`.
4. Update both READMEs and the changelog for user-visible changes.
5. Explain compatibility, security, and data-flow implications.

CI validates Node.js 22.19.0 and 24. Keep behavior compatible with the declared Node.js 22.19.0 minimum.

Do not commit generated tarballs, `node_modules`, `.env` files, Kiro API keys, OAuth access or refresh tokens, registered OIDC client secrets, device codes, Pi authentication files, model-store files from a real installation, or captured request/response bodies containing user data.

## Protocol changes

Protocol behavior must be covered by focused tests. AWS EventStream changes should test framing, CRC validation, chunk boundaries, malformed input, and cancellation where applicable. Preserve all copyright and license notices required by contributed code.
