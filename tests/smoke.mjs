import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const result = spawnSync(
  process.execPath,
  [
    cli,
    "--offline",
    "--no-extensions",
    "-e",
    "./extensions/kiro-connector.ts",
    "--list-models",
    "kiro",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KIRO_API_KEY: "ksk_smoke_test",
      KIRO_REGION: "us-east-1",
    },
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Pi smoke test failed with exit code ${result.status}:\n${output}`);
}
if (!/\bkiro\s+claude-sonnet-4\.6\b/.test(output)) {
  throw new Error(`Pi loaded the extension but did not register the expected Kiro model:\n${output}`);
}

process.stdout.write(result.stdout);
