import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROLE_NAMES, type RoleName } from "./document.js";

/** `templates/roles/` in the repo; the same relative path works from `src/` and `dist/`. */
const ROLES = fileURLToPath(new URL("../../templates/roles/", import.meta.url));

/**
 * SHA-256 of every paragraph, without backticks and with its whitespace collapsed, that any build shipped in a role's
 * instructions. Install once copied the shipped text into config version 1, so a config can
 * still hold a copy of an older build's paragraphs; those are left out of what a role gets.
 * Add the hashes of a changed paragraph here, and keep the old ones.
 */
export const SHIPPED_PARAGRAPHS: readonly string[] = [
  "fb8678e399d3894fc3aeb90563f4b04bdd9401baeeb8f26df565c2ca7bf8356f",
  "d5b902be9920f65010cf0fe756a9a8a74d186c8597e6a2489513fb5c8abe8ef3",
  "ebfd5ecf32533b96908f2ffa22e2d3163f1a29d7b779553c1580e1820c0335a0",
  "3bf6a25705fdef732214b1ccae16df36a0c3d1eed7d62c737b2fb6cd927971b7",
  "a249e721d5b5a6847aca03801c3e0c90dca270a6703b0f0b62f6f30e9885fc2e",
  "26c263d9cfe218bd44d305007e3292bca0049eb45d8ffe900c07c3cd936e0675",
  "3f96c3570367c1b700d207c03a2f0e3eced4fc588f554bab4a28c466453cffa4",
  "841d5e66e32205ac253b6e88b5e50f9da722763a3de3651368a3624073a258d2",
  "4cb2f3fb6dde03f3de4b802809bbfe1fd30f6f82a44597d4510632fe0d397b9c",
  "8a1843f96749eda4724c1fbc6fcbc130ba4c3a911693fc41895062d9fed84310",
  "7ee1b6b857c7d59d50d3cc61cae4350897448fe1aeb282e5e244c6b25c2c7ea0",
  "6a57a9027d2dc43244cb0c5c03b341448b5cfb6b70d38e80131946e3b89dd67d",
  "baa86733a1f8e744521a78b57e2408b4094668dac57c0a9085e482d257a12580",
];

/**
 * SHA-256 of every paragraph, and of every line outside a code block, normalized the same way,
 * of the coding thread instructions any build put in config version 1. The rules now ship in the messages that
 * start each thread (see {@link THREAD_RULES}), so copies left in a config are dropped.
 */
export const SHIPPED_THREAD_TEXT: readonly string[] = [
  "e3326392dd5faa54f6198264ce7602c2f9aaea838695fe4e0acdacdb4d527503",
  "e8be016644e0d4e7102a44de36772bb57b5f29be2cdb405f203e295f6519a791",
  "1142f7f01234918474f11f61b0d8289a345ac7f19f53f9e5ea4d3e3bdb00e9cf",
  "5f22a73d55bb1a7bbb2ac233bbb3462efaf67f584fec55bf7d7683c56afcb4f2",
  "86f1bdda4c077a78496c7cb58cfec86f6c87d3d5f67d3bd157ebfdf18acf17a6",
  "772a53f6c00e841edf0d50b2aa63a7321d8a2182eaafa340151e0c09363b3e60",
  "bea66a1f5d8b9a98f69dade40ccb1b03d6ea82563d71040acb2d7d343c64cb3f",
  "9da8facbbb6ada8610380a17f32f0354d3bbd7868e8cb653d2f73ebc352c7d41",
  "24d883a53ef350377fd7b2f3d853fccb5302e16d05d622221927a206d7d4e99c",
  "1f5d46b2449cec995577950d51a18c01e47224b53d106eb6298fbfade3bf2a8b",
];

/** What every implement and review thread is told first, in the message that starts it. */
export const THREAD_RULES =
  "You are working in a factory thread started by Hephaestus. Nobody watches this thread while it runs, so do not stop to ask questions: if you cannot finish, say what blocked you instead of guessing. Do only the task this message gives you, and follow the repository's own contribution rules, tests, and checks.";

/**
 * What an implement thread does when its branch is already on origin before it opened a PR, as
 * after a retry. Its own PR's branch it may rewrite, as a rebase in a conflict round needs.
 */
export function branchRule(branch: string): string {
  return `Before this thread has opened a PR, if \`${branch}\` already exists on origin and a plain push is rejected, run \`gh pr list --head ${branch} --state all\`. Only if every PR from that branch is merged or closed, overwrite it with \`git push --force-with-lease=${branch}:<the SHA you fetched>\`, and say so in your final message. If any PR from it is still open, do not push: report \`blocked\` with the reason. Once this thread's PR is open, push its branch with \`--force-with-lease\` when a rebase needs it.`;
}

const OWNER_HEADING = "## The owner's instructions";
/** The longest run of lines inside a paragraph that is checked for a shipped copy. */
const MAX_RUN_LINES = 20;

function isShipped(text: string, shipped: readonly string[]): boolean {
  // Markdown code marks do not make a copy the owner's own text.
  const plain = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(plain).digest("hex");
  return shipped.includes(hash);
}

/** The instructions this build ships for a role, which the owner cannot edit. */
export function shippedInstructions(role: RoleName): string {
  return readFileSync(`${ROLES}${role}.md`, "utf8").trim();
}

/**
 * The owner's instructions for a role, without the copies of shipped instructions they hold,
 * and how many copies were left out: a paragraph that matches a shipped one, or a run of lines
 * inside a paragraph that does, for an owner who typed straight under a copy. Everything else stays exactly as typed.
 */
export function ownInstructions(
  persona: string,
  shipped: readonly string[] = SHIPPED_PARAGRAPHS,
): { text: string; dropped: number } {
  const lines = persona.replace(/\r\n/g, "\n").split("\n");
  const keep = lines.map(() => true);
  let dropped = 0;
  for (let start = 0; start < lines.length;) {
    if ((lines[start] ?? "").trim() === "") {
      start += 1;
      continue;
    }
    let end = start;
    while (end < lines.length && (lines[end] ?? "").trim() !== "") end += 1;
    if (isShipped(lines.slice(start, end).join("\n"), shipped)) {
      for (let line = start; line < end; line += 1) keep[line] = false;
      dropped += 1;
    } else {
      // Runs of lines, longest first, so a copied block that the owner typed under still goes.
      for (let line = start; line < end;) {
        let run = Math.min(end, line + MAX_RUN_LINES);
        while (run > line && !isShipped(lines.slice(line, run).join("\n"), shipped)) run -= 1;
        if (run === line) {
          line += 1;
          continue;
        }
        for (let index = line; index < run; index += 1) keep[index] = false;
        dropped += 1;
        line = run;
      }
    }
    start = end;
  }
  const kept = lines.filter((_, index) => keep[index]).join("\n");
  // Only gaps that removed text left behind are closed up.
  const text = dropped === 0 ? kept : kept.replace(/\n{3,}/g, "\n\n");
  return { text: text.replace(/^\s*\n/, "").trimEnd(), dropped };
}

/** What a role's Hermes profile gets: the shipped instructions, then the owner's. */
export function rolePrompt(role: RoleName, persona: string): string {
  const shipped = shippedInstructions(role);
  const own = ownInstructions(persona).text;
  return own === "" ? `${shipped}\n` : `${shipped}\n\n${OWNER_HEADING}\n\n${own}\n`;
}

/** Identifies the shipped instructions of every role, so a sync can tell when a build changed them. */
export function shippedDigest(): string {
  const hash = createHash("sha256");
  for (const role of ROLE_NAMES) hash.update(`${role}\n${shippedInstructions(role)}\n`);
  return hash.digest("hex");
}
