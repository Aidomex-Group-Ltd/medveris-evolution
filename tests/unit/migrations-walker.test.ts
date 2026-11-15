import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { misplacedMigrations } from "../../scripts/migrations.js";

const roots: string[] = [];

async function tree(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "medveris-walker-"));
  roots.push(root);
  for (const file of files) {
    const path = join(root, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "-- test migration\n");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("misplaced migration walker", () => {
  it("ignores nested clones and npm ci scratch directories", async () => {
    // The loaded directory is the only place migrations are applied from; a
    // scratch checkout inside the working tree must not block db:migrate.
    const root = await tree([
      "packages/db/migrations/001_foundation.sql",
      ".tmp-npmci/1258056/packages/db/migrations/001_foundation.sql",
      ".tmp-npmci/1258056/packages/db/migrations/137_receipts_runtime_grants.sql",
      "origin/master/packages/db/migrations/001_foundation.sql",
    ]);
    const found = await misplacedMigrations(root, join(root, "packages/db/migrations"));
    expect(found).toEqual([]);
  });

  it("still reports a migration directory outside the loaded one", async () => {
    const root = await tree([
      "packages/db/migrations/001_foundation.sql",
      "apps/api/src/db/migrations/002_stray.sql",
    ]);
    const found = await misplacedMigrations(root, join(root, "packages/db/migrations"));
    expect(found).toEqual(["apps/api/src/db/migrations/002_stray.sql"]);
  });
});
