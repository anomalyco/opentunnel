import { concatBytes, parseClientHello } from "./tls-client-hello.js";
import { env, waitUntil } from "cloudflare:workers";
import { base64Url } from "./crypto.js";
import { makeApiHandler } from "./routes.js";

export { CertificateWorkflow } from "./certificate-workflow.js";
export { TunnelObject } from "./tunnel-object.js";

let apiHandler: ReturnType<typeof makeApiHandler> | undefined;

const CLIENT_HELLO_LIMIT = 64 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

const readWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("ClientHello timeout")), CLIENT_HELLO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const tunnelIDFromHostname = (hostname: string, domain: string): string | undefined => {
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const labels = hostname.slice(0, -suffix.length).split(".");
  if (labels.length === 0 || labels.length > 2) return undefined;
  return labels.at(-1) || undefined;
};

interface TcpConnection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

async function routeTcp(client: TcpConnection): Promise<void> {
  const reader = client.readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let hostname: string | undefined;
  let alpn = "";

  try {
    while (length < CLIENT_HELLO_LIMIT) {
      const item = await readWithTimeout(reader);
      if (item.done) throw new Error("Connection closed before ClientHello");
      chunks.push(item.value);
      length += item.value.byteLength;

      const result = parseClientHello(concatBytes(chunks, length));
      if (result.status === "invalid") throw new Error(result.reason);
      if (result.status === "complete") {
        hostname = result.value.serverName;
        alpn = result.value.alpn;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!hostname) throw new Error("ClientHello exceeded inspection limit");
  const tunnelID = tunnelIDFromHostname(hostname, env.OPENTUNNEL_DOMAIN);
  if (!tunnelID) throw new Error("SNI is not an OpenTunnel hostname");

  const metadata = base64Url(new TextEncoder().encode(alpn));
  const routed = env.TUNNELS.getByName(tunnelID).connect(`meta-${metadata}.${hostname}:443`, {
    allowHalfOpen: true,
  });
  await routed.opened;

  const replay = routed.writable.getWriter();
  try {
    for (const chunk of chunks) await replay.write(chunk);
  } finally {
    replay.releaseLock();
  }

  try {
    await Promise.all([
      client.readable.pipeTo(routed.writable),
      routed.readable.pipeTo(client.writable),
    ]);
  } finally {
    await Promise.allSettled([client.close(), routed.close()]);
  }
}

function relayWebSocket(request: Request): Response {
  const url = new URL(request.url);
  if (url.searchParams.get("token") !== env.RELAY_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.binaryType = "arraybuffer";
  server.accept();
  const incoming = new TransformStream<Uint8Array>();
  const incomingWriter = incoming.writable.getWriter();
  let writes = Promise.resolve();
  let closed = false;
  const closeIncoming = () => {
    if (closed) return;
    closed = true;
    writes = writes.then(() => incomingWriter.close()).catch(() => undefined);
  };

  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        if ((JSON.parse(event.data) as { type?: string }).type === "end") closeIncoming();
      } catch {
        server.close(1008, "invalid control message");
      }
      return;
    }
    writes = writes
      .then(async () => {
        const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        await incomingWriter.write(new Uint8Array(data));
      })
      .catch(() => undefined);
  });
  server.addEventListener("close", closeIncoming);
  server.addEventListener("error", closeIncoming);

  const connection: TcpConnection = {
    readable: incoming.readable,
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => server.send(chunk),
      close: () => server.send(JSON.stringify({ type: "end" })),
      abort: () => server.close(1011, "upstream error"),
    }),
    close: async () => {
      closeIncoming();
      server.close(1000, "closed");
    },
  };
  waitUntil(
    routeTcp(connection).catch((error) => {
      console.error("Relay WebSocket connection rejected", error);
      return connection.close();
    }),
  );

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/api/relay") return relayWebSocket(request);
    const connect = /^\/api\/tunnel\/([^/]+)\/connect$/.exec(url.pathname);
    if (connect && request.method === "GET") {
      return env.TUNNELS.getByName(decodeURIComponent(connect[1]!)).fetch(request);
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/openapi.json") {
      apiHandler ??= makeApiHandler();
      return apiHandler(request);
    }
    return new Response("Not found", { status: 404 });
  },

  async connect(socket): Promise<void> {
    try {
      await routeTcp(socket);
    } catch (error) {
      console.error("TCP connection rejected", error);
      await socket.close().catch(() => undefined);
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
