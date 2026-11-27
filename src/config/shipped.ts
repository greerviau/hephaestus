import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROLE_NAMES, type RoleName } from "./document.js";

/** `templates/roles/` in the repo; the same relative path works from `src/` and `dist/`. */
const ROLES = fileURLToPath(new URL("../../templates/roles/", import.meta.url));

/**
 * SHA-256 of every paragraph, with its whitespace collapsed, that any build shipped in a role's
 * instructions. Install once copied the shipped text into config version 1, so a config can
 * still hold a copy of an older build's paragraphs; those are left out of what a role gets.
 * Add the hashes of a changed paragraph here, and keep the old ones.
 */
export const SHIPPED_PARAGRAPHS: readonly string[] = [
  "fb8678e399d3894fc3aeb90563f4b04bdd9401baeeb8f26df565c2ca7bf8356f",
  "d5b902be9920f65010cf0fe756a9a8a74d186c8597e6a2489513fb5c8abe8ef3",
  "66ada506cfb6acb3afba2acc882856a9a9d4d516175535ed94b3012de40cc81d",
  "b232a040c478994800f52c23ec4bd17e9750a8875d3c4696634ac45bb1f418dd",
  "a249e721d5b5a6847aca03801c3e0c90dca270a6703b0f0b62f6f30e9885fc2e",
  "c7cfca7d6c9f4be10cc3d150c79722ee20c4215a4137aa88735c66f8dbd5d030",
  "e884aab8ae16fe5e7c230afcbc4964f6d92b2ed4f24ffd6d13d54af6adbbe0f6",
  "785d911b44b190effaef6527a6deeeaabea3fa894216d5f43d1bc8cd2db9a51e",
  "4cb2f3fb6dde03f3de4b802809bbfe1fd30f6f82a44597d4510632fe0d397b9c",
  "8a1843f96749eda4724c1fbc6fcbc130ba4c3a911693fc41895062d9fed84310",
  "97d8df22f826467271e7558b254980a897e415debc7d77a4436aac97b7c88aff",
];

const OWNER_HEADING = "## The owner's instructions";

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

function isShipped(paragraph: string): boolean {
  const hash = createHash("sha256").update(paragraph.replace(/\s+/g, " ").trim()).digest("hex");
  return SHIPPED_PARAGRAPHS.includes(hash);
}

/** The instructions this build ships for a role, which the owner cannot edit. */
export function shippedInstructions(role: RoleName): string {
  return readFileSync(`${ROLES}${role}.md`, "utf8").trim();
}

/** The owner's instructions for a role, without paragraphs that copy shipped ones, and how many were left out. */
export function ownInstructions(persona: string): { text: string; dropped: number } {
  const all = paragraphs(persona);
  const kept = all.filter((paragraph) => !isShipped(paragraph));
  return { text: kept.join("\n\n"), dropped: all.length - kept.length };
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
