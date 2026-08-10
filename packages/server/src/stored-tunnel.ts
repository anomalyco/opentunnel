import type { Certificate } from "@opentunnel/protocol/certificate";
import type { CSR } from "@opentunnel/protocol/csr";
import type { Tunnel } from "@opentunnel/protocol/tunnel";

export interface StoredTunnel {
  readonly version: 1;
  readonly id: Tunnel.ID;
  readonly hostname: CSR.Hostname;
  readonly state: Tunnel.State;
  readonly certificateID?: Certificate.ID;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
  readonly certificate?: Certificate.Info;
  readonly certificateCsr?: string;
  readonly certificateIdentifiers?: ReadonlyArray<string>;
}
