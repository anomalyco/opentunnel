export interface StatusRow {
  readonly profile: string;
  readonly hostname: string;
  readonly service: "running" | "stopped";
  readonly tunnel: "online" | "offline" | "pending" | "unreachable" | "error";
  readonly routes: number | string;
}

export function formatStatus(rows: ReadonlyArray<StatusRow>): string {
  if (rows.length === 0) return "No tunnel profiles found.";

  const values = [
    ["PROFILE", "HOSTNAME", "SERVICE", "TUNNEL", "ROUTES"],
    ...rows.map((row) => [
      row.profile,
      row.hostname,
      row.service,
      row.tunnel,
      String(row.routes),
    ]),
  ];
  const widths = values[0]!.map((_, column) =>
    Math.max(...values.map((row) => row[column]!.length))
  );
  return values
    .map((row) => row.map((value, column) =>
      column === row.length - 1 ? value : value.padEnd(widths[column]!)
    ).join("  "))
    .join("\n");
}
