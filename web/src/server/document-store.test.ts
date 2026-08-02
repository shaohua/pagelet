import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DocumentConflictError,
  createFsDocumentStore,
  type DocumentStore
} from "./document-store";

type Counter = { total: number; entries: string[] };

let root: string;
let store: DocumentStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pagelet-documents-"));
  store = createFsDocumentStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("document store", () => {
  it("returns null for a document that was never written", async () => {
    expect(await store.read("pagelets/missing")).toBeNull();
  });

  it("round-trips a document and reports a version", async () => {
    const version = await store.write("pagelets/a", { total: 1 }, null);
    const read = await store.read<Counter>("pagelets/a");

    expect(read?.value).toEqual({ total: 1 });
    expect(read?.version).toBe(version);
  });

  it("refuses to create a document that already exists", async () => {
    await store.write("pagelets/a", { total: 1 }, null);

    await expect(store.write("pagelets/a", { total: 2 }, null)).rejects.toThrow(
      DocumentConflictError
    );
  });

  it("refuses a write carrying a stale version", async () => {
    const stale = await store.write("pagelets/a", { total: 1 }, null);
    await store.write("pagelets/a", { total: 2 }, stale);

    await expect(
      store.write("pagelets/a", { total: 3 }, stale)
    ).rejects.toThrow(DocumentConflictError);
  });

  it("does not lose concurrent writes to the same document", async () => {
    // The failure this guards against is read-modify-write without a
    // precondition: every writer reads the same state and the last one wins,
    // silently dropping the rest.
    const writers = Array.from({ length: 25 }, (_, index) =>
      store.mutate<Counter>("pagelets/busy", (current) => ({
        total: (current?.total ?? 0) + 1,
        entries: [...(current?.entries ?? []), `entry-${index}`]
      }))
    );

    await Promise.all(writers);

    const read = await store.read<Counter>("pagelets/busy");
    expect(read?.value.total).toBe(25);
    expect(new Set(read?.value.entries).size).toBe(25);
  });

  it("passes null to the mutator when the document is new", async () => {
    const seen: (Counter | null)[] = [];
    await store.mutate<Counter>("pagelets/new", (current) => {
      seen.push(current);
      return { total: 1, entries: [] };
    });

    expect(seen).toEqual([null]);
  });

  it("lists keys under a prefix and ignores everything else", async () => {
    await store.write("pagelets/b", { total: 1 }, null);
    await store.write("pagelets/a", { total: 1 }, null);
    await store.write("drafts/z", { total: 1 }, null);

    expect(await store.list("pagelets")).toEqual(["pagelets/a", "pagelets/b"]);
    expect(await store.list("nothing-here")).toEqual([]);
  });

  it("removes a document and tolerates removing it twice", async () => {
    await store.write("pagelets/a", { total: 1 }, null);
    await store.remove("pagelets/a");
    await store.remove("pagelets/a");

    expect(await store.read("pagelets/a")).toBeNull();
  });

  it("leaves no partial document behind on write", async () => {
    await store.write("pagelets/a", { total: 1 }, null);
    const version = await store.write("pagelets/a", { total: 2 }, (await store.read("pagelets/a"))!.version);

    // A reader arriving at any point sees whole JSON, never a truncated file,
    // because writes land via rename.
    const read = await store.read<Counter>("pagelets/a");
    expect(read?.value).toEqual({ total: 2 });
    expect(read?.version).toBe(version);
    expect(await store.list("pagelets")).toEqual(["pagelets/a"]);
  });
});
