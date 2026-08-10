import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ApiClient } from "@peculiar/acme-client";
import { JsonWebKey as JoseJsonWebKey } from "@peculiar/jose";
import { X509Certificate } from "@peculiar/x509";
import { Certificate } from "@opentunnel/protocol/certificate";
import { base64Url, decodeBase64Url, pemBody } from "./crypto.js";

export interface CertificateWorkflowParams {
  readonly tunnelID: string;
  readonly certificateID: string;
  readonly hostname: string;
  readonly identifiers: ReadonlyArray<string>;
  readonly csr: string;
}

interface CloudflareResponse<A> {
  readonly success: boolean;
  readonly result: A;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const toPem = (buffer: ArrayBuffer): string => {
  const body = base64Url(new Uint8Array(buffer)).replace(/-/g, "+").replace(/_/g, "/");
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  return `-----BEGIN CERTIFICATE-----\n${padded.match(/.{1,64}/g)?.join("\n") ?? padded}\n-----END CERTIFICATE-----`;
};

async function patchExternalAccountBinding(
  client: ApiClient,
  publicKey: CryptoKey,
  keyID: string,
  hmacKey: string,
  newAccountUrl: string,
): Promise<void> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(hmacKey).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);

  const patchable = client as unknown as {
    createExternalAccountBinding(challenge: string, kid: string): Promise<{
      protected: string;
      payload: string;
      signature: string;
    }>;
  };
  patchable.createExternalAccountBinding = async () => {
    const protectedHeader = base64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "HS256", kid: keyID, url: newAccountUrl })),
    );
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(jwk)));
    const signature = await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(`${protectedHeader}.${payload}`),
    );
    return { protected: protectedHeader, payload, signature: base64Url(new Uint8Array(signature)) };
  };
}

export class CertificateWorkflow extends WorkflowEntrypoint<Cloudflare.Env, CertificateWorkflowParams> {
  private async update(tunnelID: string, certificateID: string, state: Certificate.State) {
    const updated = await env.TUNNELS.getByName(tunnelID).updateCertificate(certificateID, state);
    if (!updated) throw new Error("Failed to persist certificate state: tunnel or certificate not found");
  }

  async run(event: Readonly<WorkflowEvent<CertificateWorkflowParams>>, step: WorkflowStep) {
    const params = event.payload;
    try {
      return await step.do(
        "issue certificate",
        { retries: { limit: 0, delay: 0 } },
        async () => this.issue(params),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await step.do("record certificate failure", async () => {
        await this.update(params.tunnelID, params.certificateID, { type: "failed", reason });
        return { recorded: true };
      });
      return { state: "failed", reason };
    }
  }

  private async issue(params: CertificateWorkflowParams) {
    if (!env.ACME_EAB_KID || !env.ACME_EAB_HMAC_KEY) {
      throw new Error("ACME_EAB_KID and ACME_EAB_HMAC_KEY are required");
    }
    if (!env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are required");
    }

    const stored = JSON.parse(env.ACME_ACCOUNT_KEY_JWK) as JsonWebKey;
    if (
      stored.kty !== "EC" ||
      stored.crv !== "P-256" ||
      typeof stored.x !== "string" ||
      typeof stored.y !== "string" ||
      typeof stored.d !== "string"
    ) {
      throw new Error("ACME_ACCOUNT_KEY_JWK is not a P-256 private JWK");
    }
    const publicJwk: JsonWebKey = {
      kty: stored.kty,
      crv: stored.crv,
      x: stored.x,
      y: stored.y,
      ext: true,
      key_ops: ["verify"],
    };
    const accountKey: CryptoKeyPair = {
      privateKey: await crypto.subtle.importKey(
        "jwk",
        stored,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      publicKey: await crypto.subtle.importKey(
        "jwk",
        publicJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"],
      ),
    };

    const client = await ApiClient.create(accountKey, env.ACME_URL, { fetch, crypto });
    const directory = await client.getDirectory();
    await patchExternalAccountBinding(
      client,
      accountKey.publicKey,
      env.ACME_EAB_KID,
      env.ACME_EAB_HMAC_KEY,
      directory.newAccount,
    );
    await client.newAccount({
      contact: [`mailto:${env.ACME_EMAIL}`],
      termsOfServiceAgreed: true,
      externalAccountBinding: {
        kid: env.ACME_EAB_KID,
        challenge: env.ACME_EAB_HMAC_KEY,
      },
    });

    const thumbprintJwk = await crypto.subtle.exportKey("jwk", accountKey.publicKey);
    const thumbprintHex = await new JoseJsonWebKey(crypto, thumbprintJwk).getThumbprint();
    const thumbprint = base64Url(
      Uint8Array.from(thumbprintHex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)),
    );

    const order = await client.newOrder({
      identifiers: params.identifiers.map((value) => ({ type: "dns", value })),
    });
    const challenges = await Promise.all(
      order.content.authorizations.map(async (authorizationUrl, index) => {
        const authorization = await client.getAuthorization(authorizationUrl);
        const challenge = authorization.content.challenges?.find((item) => item.type === "dns-01");
        if (!challenge) throw new Error("ACME server did not offer dns-01");
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${challenge.token}.${thumbprint}`),
        );
        return {
          authorizationUrl,
          challenge,
          key: base64Url(new Uint8Array(digest)),
          hostname: params.identifiers[index]!.replace(/^\*\./, ""),
        };
      }),
    );
    const firstChallenge = challenges[0]!;
    await this.update(params.tunnelID, params.certificateID, {
      type: "challenge",
      token: firstChallenge.challenge.token,
      key: firstChallenge.key,
    });

    const endpoint = `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`;
    const recordIDs = await Promise.all(
      challenges.map(async ({ hostname, key }) => {
        const dnsResponse = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "TXT",
            name: `_acme-challenge.${hostname}`,
            content: key,
            ttl: 60,
          }),
        });
        const dns = (await dnsResponse.json()) as CloudflareResponse<{ id: string }>;
        if (!dnsResponse.ok || !dns.success) {
          throw new Error(
            dns.errors?.map((item) => item.message).filter(Boolean).join(", ") ||
              "DNS record creation failed",
          );
        }
        return dns.result.id;
      }),
    );

    try {
      await wait(Number(env.ACME_DNS_PROPAGATION_DELAY_MS || 10_000));
      for (const { authorizationUrl, challenge } of challenges) {
        await client.getChallenge(challenge.url, "POST");
        let validAuthorization = await client.getAuthorization(authorizationUrl);
        for (let attempt = 0; validAuthorization.content.status === "pending" && attempt < 30; attempt++) {
          await wait(5_000);
          validAuthorization = await client.getAuthorization(authorizationUrl);
        }
        if (validAuthorization.content.status !== "valid") {
          throw new Error(`ACME authorization ended in ${validAuthorization.content.status}`);
        }
      }

      if (!order.content.finalize) throw new Error("ACME order has no finalize URL");
      await client.finalize(order.content.finalize, { csr: base64Url(Uint8Array.from(atob(pemBody(params.csr)), (c) => c.charCodeAt(0))) });

      const orderUrl = order.headers.location;
      if (!orderUrl) throw new Error("ACME order has no location URL");
      let validOrder = await client.getOrder(orderUrl);
      for (let attempt = 0; validOrder.content.status === "processing" && attempt < 30; attempt++) {
        await wait(3_000);
        validOrder = await client.getOrder(orderUrl);
      }
      if (validOrder.content.status !== "valid" || !validOrder.content.certificate) {
        throw new Error(`ACME order ended in ${validOrder.content.status}`);
      }

      const response = await client.getCertificate(validOrder.content.certificate);
      const certificates = response.content.map(toPem);
      const certificate = certificates[0];
      if (!certificate) throw new Error("ACME response did not contain a certificate");
      const chain = certificates.slice(1).join("\n");
      const expiry = new X509Certificate(certificate).notAfter.toISOString();
      const state = { type: "ready", certificate, chain, expiry } as const;
      await this.update(params.tunnelID, params.certificateID, state);
      return state;
    } finally {
      await Promise.all(
        recordIDs.map((recordID) =>
          fetch(`${endpoint}/${recordID}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          }).catch(() => undefined),
        ),
      );
    }
  }
}
