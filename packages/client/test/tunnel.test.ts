import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type * as Tls from "node:tls";
import { create, OpenTunnelStorage, type OpenTunnelClientEvent, type OpenTunnelPromiseClient } from "../src/promise/index.js";
import { X509Certificate } from "node:crypto";
import {
  echoServer,
  fakeRelay,
  HOSTNAME,
  recordingServer,
  renewedCertificate,
  testIdentity,
  type FakeRelay,
} from "./fake-relay.js";
import { resolveRoute } from "../src/effect/tunnel.js";
import { Names } from "@opentunnel/protocol/names";
import { ProxyProtocol } from "@opentunnel/protocol/proxy-protocol";

let identity: Awaited<ReturnType<typeof testIdentity>>;
let relay: FakeRelay;
let echo: ReturnType<typeof echoServer>;
let client: OpenTunnelPromiseClient;
let store: ReturnType<typeof OpenTunnelStorage.memory>;

beforeEach(async () => {
  identity = await testIdentity();
  relay = fakeRelay(identity);
  echo = echoServer();
  store = OpenTunnelStorage.memory();
  await store.save("default", identity);
  client = create({ api: relay.url, store });
});

afterEach(async () => {
  await client.dispose();
  relay.stop();
  echo.stop();
});

const read = (socket: Tls.TLSSocket, bytes: number) =>
  new Promise<string>((resolve) => {
    let received = "";
    const onData = (data: Buffer) => {
      received += data.toString();
      if (received.length >= bytes) {
        socket.off("data", onData);
        resolve(received);
      }
    };
    socket.on("data", onData);
  });

const collect = (events: AsyncIterable<OpenTunnelClientEvent>) => {
  const seen: OpenTunnelClientEvent[] = [];
  void (async () => {
    for await (const event of events) seen.push(event);
  })();
  return seen;
};

describe("tunnel", () => {
  test("forwards TLS to the route target", async () => {
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    const session = await relay.next();
    expect(session.routes).toEqual(["api"]);

    const socket = await session.connectTls(7, `api.${HOSTNAME}`, identity.certificate);
    socket.write("hello");
    expect(await read(socket, 10)).toBe("echo:hello");

    const large = "x".repeat(200_000);
    const reply = read(socket, large.length);
    socket.write(large);
    const received = await reply;
    expect(received.replaceAll("echo:", "").length).toBe(large.length);

    expect(connection.status()).toMatchObject({ state: "connected", connections: 1 });
    socket.end();
    const closing = await Promise.race([session.next("end"), session.next("reset")]);
    expect(closing.conn).toBe(7);
    await connection.close();
  });

  test("serves the root route", async () => {
    const connection = await client.tunnel.connect({ routes: { "@": echo.target } });
    const session = await relay.next();
    const socket = await session.connectTls(1, HOSTNAME, identity.certificate);
    socket.write("root");
    expect(await read(socket, 9)).toBe("echo:root");
    await connection.close();
  });

  test("resets unknown routes", async () => {
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    const session = await relay.next();
    session.open(3, `admin.${HOSTNAME}`);
    expect(await session.next("reset")).toEqual({ type: "reset", conn: 3, code: "unknown_route" });
    await connection.close();
  });

  test("resets connections beyond the advertised max_conns", async () => {
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    const session = await relay.next();
    for (let conn = 1; conn <= 256; conn++) session.open(conn, `api.${HOSTNAME}`);
    session.open(257, `api.${HOSTNAME}`);
    expect(await session.next("reset")).toEqual({ type: "reset", conn: 257, code: "too_many_connections" });
    expect(connection.status().connections).toBe(256);
    await connection.close();
  });

  test("reconnects after the bridge closes", async () => {
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    const events = collect(connection.events);
    (await relay.next()).close();
    await relay.next();
    expect(events.some((event) => event.type === "reconnecting")).toBe(true);
    await connection.close();
  });

  test("re-attaches only when route names change", async () => {
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    await relay.next();

    await connection.setRoutes({ api: "127.0.0.1:9" });
    const reattached = relay.next();
    const early = await Promise.race([reattached.then(() => "attached"), Bun.sleep(300).then(() => "none")]);
    expect(early).toBe("none");
    expect(connection.status().routes).toEqual({ api: "127.0.0.1:9" });

    await connection.setRoutes({ api: echo.target, "@": echo.target });
    const session = await reattached;
    expect([...session.routes].sort()).toEqual(["@", "api"]);
    await connection.close();
  });

  test("rejects invalid routes before connecting", async () => {
    await expect(client.tunnel.connect({ routes: { api: "http://x" } })).rejects.toThrow("Invalid target");
    await expect(
      client.tunnel.connect({ routes: { api: { target: echo.target, proxyProtocol: "v3" as "v2" } } }),
    ).rejects.toThrow("Invalid proxyProtocol");
  });

  describe("route options", () => {
    const deliver = async (
      route: (target: string) => string | { target: string; proxyProtocol?: "v1" | "v2" },
      peer: string,
      payload: string,
      expected: number,
    ) => {
      const recorder = await recordingServer();
      try {
        const connection = await client.tunnel.connect({ routes: { api: route(recorder.target) } });
        const session = await relay.next();
        const socket = await session.connectTls(5, `api.${HOSTNAME}`, identity.certificate, peer);
        socket.write(payload);
        await recorder.received(expected);
        // Anything beyond what was expected would arrive within a moment.
        await Bun.sleep(50);
        await connection.close();
        return recorder.data();
      } finally {
        recorder.stop();
      }
    };

    test("default routes forward bytes unchanged", async () => {
      const payload = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
      for (const route of [(target: string) => target, (target: string) => ({ target })]) {
        const received = await deliver(route, "203.0.113.9:51234", payload, payload.length);
        expect(received.toString("latin1")).toBe(payload);
      }
    });

    test("writes a PROXY v1 header before the payload", async () => {
      const received = await deliver(
        (target) => ({ target, proxyProtocol: "v1" }),
        "203.0.113.9:51234",
        "hello",
        47,
      );
      expect(received.toString("latin1")).toBe("PROXY TCP4 203.0.113.9 0.0.0.0 51234 443\r\nhello");
    });

    test("writes a PROXY v2 header before the payload", async () => {
      const received = await deliver(
        (target) => ({ target, proxyProtocol: "v2" }),
        "[2001:db8::1]:443",
        "hello",
        16 + 36 + 3 + 13 + 5,
      );
      const header = ProxyProtocol.header("v2", "[2001:db8::1]:443", `api.${HOSTNAME}`);
      expect(received.subarray(0, 14)).toEqual(Buffer.from("0d0a0d0a000d0a515549540a2121", "hex"));
      expect(received.subarray(0, header.length)).toEqual(Buffer.from(header));
      expect(received.subarray(header.length).toString("latin1")).toBe("hello");
      expect(received.subarray(header.length - 13, header.length).toString("latin1")).toBe(`api.${HOSTNAME}`);
    });

    test("match the shared vectors", async () => {
      const vectors = await Bun.file(new URL("../../../spec/vectors/route-options.json", import.meta.url)).json();
      for (const { name, sdk, route, error } of vectors.routes) {
        if (error) {
          expect(() => resolveRoute(name, sdk)).toThrow();
          continue;
        }
        const resolved = resolveRoute(name, sdk);
        const target = Names.parseTarget(route.target)!;
        expect(resolved).toEqual(route.proxyProtocol ? { target, proxyProtocol: route.proxyProtocol } : { target });
      }
    });
  });

  test("fails on fatal attach errors", async () => {
    relay.attachError = "bad_token";
    await expect(client.tunnel.connect({ routes: { api: echo.target } })).rejects.toThrow();
  });

  test("picks up a certificate the server renewed while offline", async () => {
    const renewed = await renewedCertificate(identity.privateKey);
    relay.served = { certificate: renewed, chain: "" };
    const connection = await client.tunnel.connect({ routes: { api: echo.target } });
    expect(connection.tunnel.certificate).toBe(renewed);
    const saved = await store.load("default");
    expect(saved?.certificate).toBe(renewed);
    expect(saved?.privateKey).toBe(identity.privateKey);

    const session = await relay.next();
    const socket = await session.connectTls(5, `api.${HOSTNAME}`, renewed);
    const presented = new X509Certificate(socket.getPeerCertificate().raw);
    expect(presented.fingerprint256).toBe(new X509Certificate(renewed).fingerprint256);
    await connection.close();
  });
});
