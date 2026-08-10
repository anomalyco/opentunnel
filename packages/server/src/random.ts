export * as Random from "./random.js";

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

export function slug(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let value = "";
  for (const byte of bytes) value += alphabet[byte & 31];
  return value;
}
