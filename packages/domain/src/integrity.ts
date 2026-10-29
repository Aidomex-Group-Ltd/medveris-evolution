async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface MerkleLeaf {
  id: string;
  eventHash: string;
}

/**
 * Root of the audit-event Merkle tree signed into each integrity checkpoint. Leaves are
 * SHA-256(`id:eventHash`) in occurred_at, id order; an odd node is paired with itself.
 */
export async function merkleRootOf(leaves: readonly MerkleLeaf[]): Promise<string> {
  if (!leaves.length) return await sha256Hex("");
  let level: string[] = [];
  for (const leaf of leaves) level.push(await sha256Hex(`${leaf.id}:${leaf.eventHash}`));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0]!;
}
