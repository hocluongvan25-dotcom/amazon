/** Băm prompt cho llm_runs (SHA-256, server-side). */
import { createHash } from "node:crypto";

export function hashMessages(messages: unknown): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}
