export * as CSR from "./csr.js";

import { Schema } from "effect";

export const Raw = Schema.String.pipe(Schema.brand("CSR.Raw"));
export type Raw = Schema.Schema.Type<typeof Raw>;

export const Hostname = Schema.String.pipe(Schema.brand("Hostname"));
export type Hostname = Schema.Schema.Type<typeof Hostname>;
