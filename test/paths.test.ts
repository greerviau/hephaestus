import { describe, expect, it } from "vitest";
import { resolvePaths } from "../src/paths.js";

describe("resolvePaths", () => {
  it("keeps all state under ~/.hephaestus", () => {
    const paths = resolvePaths({ HOME: "/home/owner" });

    expect(paths.root).toBe("/home/owner/.hephaestus");
    expect(paths.unit).toBe("/home/owner/.config/systemd/user/hephaestus.service");
  });

  it("uses an absolute XDG_CONFIG_HOME for the unit", () => {
    expect(resolvePaths({ HOME: "/home/owner", XDG_CONFIG_HOME: "/xdg" }).unit).toBe(
      "/xdg/systemd/user/hephaestus.service",
    );
  });

  it.each(["", "relative/config"])("ignores XDG_CONFIG_HOME=%j", (value) => {
    expect(resolvePaths({ HOME: "/home/owner", XDG_CONFIG_HOME: value }).unit).toBe(
      "/home/owner/.config/systemd/user/hephaestus.service",
    );
  });
});
