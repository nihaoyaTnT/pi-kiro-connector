# pi-kiro-connector

A standalone [Pi](https://pi.dev) package that connects Pi directly to Kiro. It does not require Kiro-Go, a local proxy, or another gateway process.

[简体中文](README.zh-CN.md)

## Features

- Registers an independent `kiro` provider without replacing Pi's built-in Anthropic provider
- Calls the regional Kiro Runtime directly and decodes AWS EventStream responses
- Supports streaming text, reasoning, images, Pi tools, tool results, and cancellation
- Discovers models and token limits from Kiro's regional model catalog
- Provides a built-in fallback catalog for offline startup
- Supports Pi's `/login kiro` credential store or `KIRO_API_KEY`
- Adds `/kiro-status`, `/kiro-use`, and the LLM-callable `kiro_connection` tool
- Never returns or intentionally logs API keys
- Has no runtime npm dependencies beyond Pi's package peers

## Requirements

1. Node.js 20 or newer
2. Pi 0.83.0 or newer
3. A Kiro API key, typically beginning with `ksk_`

Use only credentials and services you are authorized to access. This independent compatibility project is not an official Kiro client.

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

Enter your Kiro API key as either `ksk_...` or `ksk_...|region`. Pi stores the credential in its normal provider credential store; the connector does not create a separate credential file.

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

Do not put a real key in `.env.example`, source control, issue reports, screenshots, or shell history shared with others.

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

The status command and tool report only the credential source, region endpoint, status, and model count. They do not return the key.

## How it works

The connector translates Pi messages into Kiro's native conversation format and sends them directly to:

```text
https://runtime.<region>.kiro.dev/
```

It discovers model metadata through Kiro's regional CodeWhisperer model-catalog operation. Runtime responses use binary AWS EventStream framing; the connector incrementally validates frame CRCs and maps text, reasoning, usage, and tool events into Pi's native stream protocol.

Pi controls reasoning through `/settings`, Shift+Tab, or `--thinking`. The connector adds Kiro's reasoning prompt only when a Pi reasoning level is enabled.

Pi caches a successfully discovered model catalog through its provider model store. The stored catalog contains model metadata only. A small static catalog keeps the provider visible during offline startup.

## Troubleshooting

### Authentication fails

Run `/login kiro` again or verify that `KIRO_API_KEY` is the Kiro account key—not an API key for a third-party gateway. `/kiro-status` reports HTTP 401 or 403 without displaying the credential.

### The regional endpoint fails

Verify `KIRO_REGION`. It must be a region label such as `us-east-1` or `eu-central-1`. Remove obsolete `KIRO_BASE_URL` settings; this standalone version does not use them.

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

Validation runs TypeScript checks, protocol/unit tests, an offline Pi loading smoke test, and `npm pack --dry-run`. CI runs the suite on Node.js 20, 22, and 24.

## Security and privacy

Requests contain the conversation context needed for inference and are sent directly to Kiro's regional services. No connector-operated relay is involved. See [SECURITY.md](SECURITY.md) for credential handling, reporting, and review guidance.

## License and attribution

This project is licensed under [MIT](LICENSE). Protocol implementation research was informed by the MIT-licensed Kiro-Go project; its copyright and license notice are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Kiro-Go is not a runtime dependency.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This independent project is not affiliated with, endorsed by, or sponsored by Amazon, AWS, Kiro, the Pi maintainers, or the Kiro-Go maintainers. Product names are used only to describe compatibility.
