import { describe, expect, test } from "bun:test";
import { formatStatus } from "./status.js";

describe("formatStatus", () => {
  test("formats profiles as an aligned table", () => {
    expect(formatStatus([
      {
        profile: "default",
        hostname: "vogel.opentunnel.xyz",
        service: "running",
        tunnel: "online",
        routes: 3,
      },
      {
        profile: "demo",
        hostname: "demo.opentunnel.xyz",
        service: "stopped",
        tunnel: "offline",
        routes: 1,
      },
    ])).toBe([
      "PROFILE  HOSTNAME              SERVICE  TUNNEL   ROUTES",
      "default  vogel.opentunnel.xyz  running  online   3",
      "demo     demo.opentunnel.xyz   stopped  offline  1",
    ].join("\n"));
  });

  test("describes an empty profile list", () => {
    expect(formatStatus([])).toBe("No tunnel profiles found.");
  });
});
