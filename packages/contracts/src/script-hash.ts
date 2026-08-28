import { createHash } from "node:crypto";

/**
 * The one definition of "the hash of a script", shared by the manifest
 * generator (packages/scripts) and the agent's executor (apps/agent-node).
 * It lives in contracts precisely so those two cannot drift: a divergence
 * between them reintroduces the bug below in a form that only appears on
 * one platform.
 *
 * Line endings are normalized to LF before hashing. Without this the same
 * script hashes differently depending on how git checked it out — the repo
 * stores LF, Windows checkouts convert to CRLF — and the executor's
 * hash-pinning check then refuses every signed script on every Windows
 * agent, which is every agent. That silently disabled the entire playbook
 * library.
 *
 * Normalizing does not weaken the guarantee. CRLF/LF conversion cannot
 * change what a PowerShell script does, so two files that normalize to the
 * same bytes are the same script. Every other byte must still match
 * exactly, which is the property hash pinning exists to provide.
 */
export function hashScriptContent(content: Buffer | string): string {
  const text = typeof content === "string" ? content : content.toString("utf-8");
  const normalized = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}
