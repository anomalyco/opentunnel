import { Effect, Layer, Context } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import pkg from "../../package.json" with { type: "json" };
import { HttpApiClient } from "effect/http-api";
import { Api } from "@opentunnel/protocol/api/api";
import { Tunnel } from "@opentunnel/protocol/tunnel";

/** How the SDK identifies itself to the server, on API calls and the bridge. */
export const USER_AGENT = `opentunnel-sdk/${pkg.version}`;

type Client = HttpApiClient.ForApi<typeof Api>;

interface OpenTunnelApi {
  readonly client: Client;
  readonly authorized: (token: Tunnel.Token) => Effect.Effect<Client>;
}

export class OpenTunnelApiClient extends Context.Service<OpenTunnelApiClient, OpenTunnelApi>()(
  "@opentunnel/client/OpenTunnelApiClient",
) {
  static layer(options: { readonly api: URL | string }) {
    return Layer.effect(
      OpenTunnelApiClient,
      Effect.gen(function* () {
        const httpClient = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("user-agent", USER_AGENT)),
        );
        const client = yield* HttpApiClient.makeWith(Api, {
          baseUrl: options.api,
          httpClient,
        });
        return {
          client,
          authorized: (token) =>
            HttpApiClient.makeWith(Api, {
              baseUrl: options.api,
              httpClient: httpClient.pipe(
                HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
              ),
            }),
        };
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
  }
}
