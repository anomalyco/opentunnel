import { Effect, Layer, ServiceMap } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Api } from "@opentunnel/protocol/api/api";
import { Tunnel } from "@opentunnel/protocol/tunnel";

type Client = HttpApiClient.ForApi<typeof Api>;

interface OpenTunnelApi {
  readonly client: Client;
  readonly authorized: (token: Tunnel.Token) => Effect.Effect<Client>;
}

export class OpenTunnelApiClient extends ServiceMap.Service<OpenTunnelApiClient, OpenTunnelApi>()(
  "@opentunnel/client/OpenTunnelApiClient",
) {
  static layer(options: { readonly api: URL | string }) {
    return Layer.effect(
      OpenTunnelApiClient,
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
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
