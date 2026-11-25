import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadItem } from "../t3/adapter.js";

/** `templates/` in the repo; the same relative path works from `src/` and `dist/`. */
const TEMPLATES = fileURLToPath(new URL("../../templates/", import.meta.url));

function script(name: string): string {
  return readFileSync(join(TEMPLATES, "worker", name), "utf8");
}

const RUN_EXACTLY =
  "Do not change, inspect, or second-guess the script, and do not run anything else.";

/** The first message of a deploy thread: the fixed script inline, and the version to install. */
export function deployMessage(version: number, sha: string, repoUrl: string): string {
  return `Hephaestus deploy thread. Save the script below exactly as \`deploy.sh\` in the current directory, then run \`bash deploy.sh ${String(version)} ${sha} ${repoUrl}\` once. ${RUN_EXACTLY} Reply with the script's full output in one fenced block, and nothing else.

\`\`\`bash
${script("deploy.sh")}\`\`\``;
}

export function claudeSignInMessage(): string {
  return `Hephaestus sign-in thread for the Factory Claude provider instance on this machine. Do exactly these two steps and nothing else.

1. Call the \`request_secret\` tool with label "Factory Claude token", reason "Run \`claude setup-token\` on any machine and paste the token it prints. It signs in the Factory Claude instance on this machine.", and delivery "file". Wait for the owner to submit it.
2. Save the script below exactly as \`set-claude-token.sh\` in the current directory and run \`bash set-claude-token.sh <path of the file that request_secret returned>\`. Do not print, read, or inspect the secret file yourself, and do not change the script.

Reply with the script's output in one fenced block, and nothing else.

\`\`\`bash
${script("set-claude-token.sh")}\`\`\``;
}

/** Waiting on the device login, in 5-second checks; the code itself expires after 15 minutes. */
const CODEX_WAIT_CHECKS = 115;

export function codexSignInMessage(): string {
  return `Hephaestus sign-in thread for the Factory Codex provider instance on this machine. Make exactly two shell calls, in this order, in this one turn, without changing the commands. The owner approves the code that the first call prints while the second call waits, so do not end your turn between them.

First shell call:

\`\`\`bash
export CODEX_HOME=$HOME/.hephaestus/codex
log=$HOME/.hephaestus/codex-login.log
setsid nohup codex login --device-auth > "$log" 2>&1 < /dev/null & disown
sleep 8
sed -e 's/\\x1b\\[[0-9;]*m//g' "$log" | grep -E 'https://|^ +[A-Z0-9]{4}-[A-Z0-9]{4,}'
\`\`\`

Second shell call, with a timeout of at least 600000 ms:

\`\`\`bash
for i in $(seq 1 ${String(CODEX_WAIT_CHECKS)}); do
  if CODEX_HOME=$HOME/.hephaestus/codex codex login status 2>&1 | grep -q 'Logged in'; then break; fi
  sleep 5
done
if CODEX_HOME=$HOME/.hephaestus/codex codex login status 2>&1 | grep -q 'Logged in'; then echo CODEX-SIGNED-IN; else echo CODEX-NOT-SIGNED-IN; fi
\`\`\`

Reply with the second call's output in one fenced block, nothing else.`;
}

export function cleanupMessage(): string {
  return `Hephaestus cleanup thread. The owner is uninstalling Hephaestus. Save the script below exactly as \`cleanup.sh\` in the current directory and run \`bash cleanup.sh\` once. It removes only what Hephaestus added to this machine. ${RUN_EXACTLY} Reply with its full output in one fenced block, and nothing else.

\`\`\`bash
${script("cleanup.sh")}\`\`\``;
}

export const TEST_REPLY = "FACTORY-READY";

export function testTurnMessage(): string {
  return `Hephaestus sign-in check. Reply with exactly ${TEST_REPLY} and nothing else. Do not run any tools.`;
}

/** The text of the thread's last assistant message. */
export function finalMessage(items: ThreadItem[]): string | undefined {
  return items.filter((item) => item.type === "assistant_message").at(-1)?.text;
}

export interface DeployResult {
  version: number;
  head: string;
  home: string;
  instances: string;
}

/** Reads the `DEPLOYED ...` line that deploy.sh prints last, or the reason it gave for failing. */
export function parseDeploy(text: string): DeployResult | { failure: string } {
  const failed = /DEPLOY-FAILED (.+)/.exec(text);
  if (failed?.[1] !== undefined) return { failure: failed[1].trim() };
  const match = /DEPLOYED version=(\d+) head=([0-9a-f]{40}) home=(\S+) instances=(\S+)/.exec(text);
  if (match === null) return { failure: "the deploy thread did not report a result" };
  return {
    version: Number(match[1]),
    head: match[2] ?? "",
    home: match[3] ?? "",
    instances: match[4] ?? "",
  };
}

export interface DeviceCode {
  url: string;
  code: string;
}

/** The device-login link and code from the Codex sign-in thread's first shell call. */
export function parseDeviceCode(items: ThreadItem[]): DeviceCode | undefined {
  for (const item of items) {
    if (item.type !== "command_execution") continue;
    const url = /https:\/\/auth\.openai\.com\/\S+/.exec(item.text)?.[0];
    const code = /^\s+([A-Z0-9]{4}-[A-Z0-9]{4,})\s*$/m.exec(item.text)?.[1];
    if (url !== undefined && code !== undefined) return { url, code };
  }
  return undefined;
}
