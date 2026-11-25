import { UNIT_MARKER, quoteArgument } from "../service.js";

/** systemd expands `%` specifiers in Environment= values too, so they are doubled. */
function environmentValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`A unit value cannot contain a line break: ${value}`);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/**
 * The unit for the factory's own Hermes gateway. It serves the factory
 * profiles and runs the factory board's dispatcher, and with HERMES_HOME set
 * to the factory root it never sees the owner's Hermes home.
 */
export function gatewayUnitFile(hermesPath: string, root: string): string {
  return [
    UNIT_MARKER,
    "[Unit]",
    "Description=Hermes gateway for the Hephaestus factory",
    "After=network-online.target",
    "",
    "[Service]",
    `Environment=${environmentValue(`HERMES_HOME=${root}`)}`,
    `Environment=${environmentValue(`HERMES_KANBAN_HOME=${root}`)}`,
    `ExecStart=:${[hermesPath, "gateway", "run"].map(quoteArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
