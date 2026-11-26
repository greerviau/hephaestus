import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryHermes } from "./cli.js";

/** `templates/hermes/plugin/hephaestus` in the repo; the same relative path works from `src/` and `dist/`. */
const SOURCE = fileURLToPath(new URL("../../templates/hermes/plugin/hephaestus/", import.meta.url));
export const PLUGIN_NAME = "hephaestus";

/**
 * Installs and enables the plugin that adds `hermes hephaestus`, which the
 * Model page uses to set the factory Hermes's provider and model. It goes in
 * the factory root only, so the owner's own Hermes never loads it.
 */
export async function installModelPlugin(hermes: FactoryHermes): Promise<void> {
  const target = join(hermes.root, "plugins", PLUGIN_NAME);
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(SOURCE)) {
    if (!lstatSync(join(SOURCE, name)).isFile()) continue;
    copyFileSync(join(SOURCE, name), join(target, name));
  }
  await hermes.run(["plugins", "enable", PLUGIN_NAME]);
}
