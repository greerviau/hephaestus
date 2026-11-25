import { describe, expect, it } from "vitest";
import { gatewayUnitFile } from "../../src/hermes/gateway.js";
import { UNIT_MARKER } from "../../src/service.js";

describe("gatewayUnitFile", () => {
  it("runs the Hermes gateway against the factory root under the Hephaestus marker", () => {
    const unit = gatewayUnitFile("/usr/local/bin/hermes", "/home/owner/.hephaestus/hermes 100%");

    expect(unit.split("\n")[0]).toBe(UNIT_MARKER);
    expect(unit).toContain('Environment="HERMES_HOME=/home/owner/.hephaestus/hermes 100%%"');
    expect(unit).toContain('Environment="HERMES_KANBAN_HOME=/home/owner/.hephaestus/hermes 100%%"');
    expect(unit).toContain('ExecStart=:"/usr/local/bin/hermes" "gateway" "run"');
    expect(unit).toContain("WantedBy=default.target");
  });
});
