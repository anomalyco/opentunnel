export * as Names from "./names.js";

/** The route name for the tunnel hostname itself. */
export const ROOT_ROUTE = "@";

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isValidRoute = (value: string): boolean => value === ROOT_ROUTE || label.test(value);

export const isValidProfile = (value: string): boolean => label.test(value);

/** Resolves the route name for a TLS SNI on the given tunnel hostname. */
export const routeForSni = (sni: string, hostname: string): string | undefined => {
  const name = sni.toLowerCase();
  const host = hostname.toLowerCase();
  if (name === host) return ROOT_ROUTE;
  const suffix = `.${host}`;
  if (!name.endsWith(suffix)) return undefined;
  const route = name.slice(0, -suffix.length);
  return label.test(route) ? route : undefined;
};

/** Validates a `host:port` route target and returns its parts. */
export const parseTarget = (value: string): { readonly host: string; readonly port: number } | undefined => {
  const separator = value.lastIndexOf(":");
  if (separator === -1) return undefined;
  const portText = value.slice(separator + 1);
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  let host = value.slice(0, separator);
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return undefined;
    host = host.slice(1, -1);
  }
  if (!host || !/^[A-Za-z0-9.\-:_]+$/.test(host)) return undefined;
  return { host, port };
};
