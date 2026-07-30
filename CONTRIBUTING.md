# Contributing

Contributions are welcome.

## Development

Requirements: Node.js 20 or newer and Pi 0.83.0 or newer.

```bash
npm ci
npm run validate
```

Try the extension without installing it globally:

```bash
pi --offline --no-extensions -e ./extensions/kiro-connector.ts --list-models kiro
```

For an authorized end-to-end test, configure a Kiro API key and run:

```bash
KIRO_API_KEY='ksk_...|us-east-1' pi --no-extensions \
  -e ./extensions/kiro-connector.ts \
  --provider kiro --model claude-sonnet-4.6 -p 'Reply with OK'
```

PowerShell users can set `$env:KIRO_API_KEY` and `$env:KIRO_REGION` before starting Pi.

## Pull requests

1. Keep credentials and local configuration out of commits.
2. Add or update tests for protocol and behavior changes.
3. Run `npm run validate`.
4. Update both READMEs and the changelog for user-visible changes.
5. Explain compatibility, security, and data-flow implications.

CI validates Node.js 20, 22, and 24. Keep behavior compatible with the declared Node.js 20 minimum.

Do not commit generated tarballs, `node_modules`, `.env` files, Kiro credentials, Pi authentication files, model-store files from a real installation, or captured request/response bodies containing user data.

## Protocol changes

Protocol behavior must be covered by focused tests. AWS EventStream changes should test framing, CRC validation, chunk boundaries, malformed input, and cancellation where applicable. Preserve all copyright and license notices required by contributed code.
