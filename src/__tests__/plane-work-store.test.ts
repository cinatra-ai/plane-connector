// plane-work-store impl tests — exercise the PmConnector v2 typed work-item CRUD
// store (cinatra#1031) against a mocked fetch, asserting the SMOKE-PROVEN wire
// facts + the contract guarantees:
//   - X-API-Key is the SOLE auth header (never Authorization: Bearer); no
//     surfaced error leaks the PAT.
//   - CRUD scopes to /workspaces/{slug}/projects/{projectId}/work-items/.
//   - dates use start_date/target_date (NEVER due_date); a date CLEAR is sent as
//     null and read-back verified (a silent no-op clear fails loud).
//   - NATURAL-KEY IDEMPOTENCY: a repeat create converges on the SAME item
//     (paginated find-or-create by the [cinatra-work:<key>] marker), never a
//     duplicate; a FAILED lookup throws (never blind-creates).
//   - status + dependency edges round-trip through the fenced, namespaced
//     [cinatra-work-store] metadata block; a body carrying the reserved tokens is
//     rejected before any write.
//   - READ-AFTER-WRITE: every mutation reads the item back (SEPARATE GET, key
//     DERIVED from the landed marker) and a mismatch is a LOUD write_verification
//     error (never silent).
//   - CAS: a stale expectedVersion throws a `conflict`.
//   - listWorkItems EXHAUSTS pagination (follows the cursor).
//   - comments create + read-back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planeWorkStore, PlaneWorkStoreError } from "../plane-work-store";
import {
  registerPlaneConnector,
  _resetPlaneDepsForTests,
  type PlaneInstanceConfig,
  type PlaneConnectorHostDeps,
} from "../deps";

const INSTANCE: PlaneInstanceConfig = {
  instanceId: "plane-default",
  baseUrl: "http://127.0.0.1:3400",
  workspaceSlug: "cinatra-smoke",
  projectId: "9e051c95-7408-4d4e-896e-c714e02e5713",
  encryptedPat: { ciphertext: "ct", iv: "iv" },
  updatedAt: "2026-06-19T00:00:00.000Z",
};
const PAT_PLAINTEXT = "plane_api_smoke_test_token";
const PROJECT_BASE =
  "http://127.0.0.1:3400/api/v1/workspaces/cinatra-smoke/projects/9e051c95-7408-4d4e-896e-c714e02e5713";

function buildDeps(): PlaneConnectorHostDeps {
  return {
    secretsCodec: {
      encryptSecret: (plaintext) => ({ ciphertext: plaintext, iv: "iv" }),
      decryptSecret: () => PAT_PLAINTEXT,
    },
    loadInstanceConfig: async () => INSTANCE,
    saveInstanceConfig: async () => {},
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  registerPlaneConnector(buildDeps());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  _resetPlaneDepsForTests();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A raw Plane work item whose description encodes the fenced status+deps block,
 *  marker title, and dates — so read-back asserts pass (or, with tweaks, fail). */
function rawItem(opts: {
  id: string;
  key: string;
  title?: string;
  status: string;
  deps?: string[];
  start?: string | null;
  due?: string | null;
  assignees?: string[];
  updated_at?: string;
}): Record<string, unknown> {
  const human = opts.title ?? "";
  const block = `[cinatra-work-store]\nstatus: ${opts.status}\ndeps: ${(opts.deps ?? []).join("|")}\n[/cinatra-work-store]`;
  const desc = human ? `${human}\n\n${block}` : block;
  return {
    id: opts.id,
    name: `${human} [cinatra-work:${opts.key}]`.trim(),
    description_stripped: desc,
    start_date: opts.start ?? null,
    target_date: opts.due ?? null,
    assignees: opts.assignees ?? [],
    updated_at: opts.updated_at ?? "2026-07-01T00:00:00Z",
  };
}

const DRAFT = {
  naturalKey: "proj1/build",
  title: "Build the thing",
  body: "do the build",
  status: "todo" as const,
  startDate: "2026-07-10" as string | null,
  dueDate: "2026-07-12" as string | null,
  assigneeIds: [] as string[],
  dependsOn: ["proj1/plan"] as string[],
};

describe("planeWorkStore — create (find-or-create) + read-after-write", () => {
  it("first create (marker miss → CREATE): X-API-Key only, scoped URL, start/target dates never due_date, marker + fenced status/deps, returns landed item", async () => {
    fetchMock
      // 1) paginated find-by-marker LIST -> none
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      // 2) CREATE -> 201
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-1" }))
      // 3) read-after-write GET -> the persisted item echoing what we sent
      .mockResolvedValueOnce(
        jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", title: "Build the thing", status: "todo", deps: ["proj1/plan"], start: "2026-07-10", due: "2026-07-12" })),
      );

    const item = await planeWorkStore.createWorkItem({ item: { ...DRAFT } });

    expect(item.id).toBe("wi-1");
    expect(item.naturalKey).toBe("proj1/build");
    expect(item.status).toBe("todo");
    expect(item.startDate).toBe("2026-07-10");
    expect(item.dueDate).toBe("2026-07-12");
    expect(item.dependsOn).toEqual(["proj1/plan"]);
    expect(item.title).toBe("Build the thing");
    expect(item.version).toBe("2026-07-01T00:00:00Z"); // from updated_at

    // find LIST addressed the work-store marker namespace.
    expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain("[cinatra-work:proj1/build]");

    // CREATE call: scoped URL, POST, X-API-Key only, dates + marker + fenced block.
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${PROJECT_BASE}/work-items/`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(PAT_PLAINTEXT);
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    const sent = JSON.parse(init.body as string);
    expect(sent.start_date).toBe("2026-07-10");
    expect(sent.target_date).toBe("2026-07-12");
    expect("due_date" in sent).toBe(false);
    expect(sent.name).toContain("[cinatra-work:proj1/build]");
    expect(sent.description).toContain("[cinatra-work-store]");
    expect(sent.description).toContain("status: todo");
    expect(sent.description).toContain("deps: proj1/plan");
  });

  it("IDEMPOTENCY (repeat-run): a second create for the same natural key finds + PATCHes the existing item (never a duplicate) — both runs return the SAME id", async () => {
    // Run 1: miss -> create wi-1 -> readback.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-1" }))
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", deps: ["proj1/plan"], start: "2026-07-10", due: "2026-07-12", title: "Build the thing" })));
    const first = await planeWorkStore.createWorkItem({ item: { ...DRAFT } });
    expect(first.id).toBe("wi-1");

    // Run 2: marker HIT (wi-1 already exists) -> PATCH wi-1 -> readback. NO create.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "wi-1", name: "Build the thing [cinatra-work:proj1/build]" }], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-1" })) // PATCH echo (ignored)
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", deps: ["proj1/plan"], start: "2026-07-10", due: "2026-07-12", title: "Build the thing" })));
    const second = await planeWorkStore.createWorkItem({ item: { ...DRAFT } });

    expect(second.id).toBe("wi-1"); // converged on the SAME item
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
    expect(fetchMock.mock.calls[1][0]).toContain("/work-items/wi-1/");
    expect(fetchMock.mock.calls.every((c) => (c[1]?.method ?? "GET") !== "POST")).toBe(true);
  });

  it("READ-AFTER-WRITE: LOUDLY fails when the persisted status does not match what was sent (never silent)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-2" }))
      // read-back shows status BACKLOG though we sent TODO -> mismatch.
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-2", key: "proj1/build", status: "backlog", deps: ["proj1/plan"], start: "2026-07-10", due: "2026-07-12", title: "Build the thing" })));

    const err = await planeWorkStore.createWorkItem({ item: { ...DRAFT } }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaneWorkStoreError);
    expect(err.code).toBe("write_verification");
  });

  it("READ-AFTER-WRITE: LOUDLY fails when the WHOLE [cinatra-work-store] block is LOST on a backlog/empty-deps write (default-equivalence must NOT pass)", async () => {
    // The insidious case: we send status "backlog" + no deps — which are ALSO the
    // values `toWorkItem` DEFAULTS to when the block is absent. If the read-back
    // only compared mapped values, a total loss of the authoritative block would
    // pass as a no-op-equal round-trip. It must fail: the block itself is gone.
    const backlogDraft = { ...DRAFT, status: "backlog" as const, dependsOn: [] as string[] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-5" }))
      // read-back: marker + dates intact, but Plane DROPPED the description block.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-5",
          name: "Build the thing [cinatra-work:proj1/build]",
          description_stripped: "do the build",
          start_date: "2026-07-10",
          target_date: "2026-07-12",
          assignees: [],
          updated_at: "u",
        }),
      );

    const err = await planeWorkStore.createWorkItem({ item: backlogDraft }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaneWorkStoreError);
    expect(err.code).toBe("write_verification");
    expect(String(err.message)).toMatch(/metadata block/);
  });

  it("READ-AFTER-WRITE: LOUDLY fails when the persisted block is MANGLED (fences present, no valid status:)", async () => {
    const backlogDraft = { ...DRAFT, status: "backlog" as const, dependsOn: [] as string[] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-6" }))
      // block survives but the status: line was lost -> parses to null, must throw.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-6",
          name: "Build the thing [cinatra-work:proj1/build]",
          description_stripped: "do the build\n\n[cinatra-work-store]\ndeps: \n[/cinatra-work-store]",
          start_date: "2026-07-10",
          target_date: "2026-07-12",
          assignees: [],
          updated_at: "u",
        }),
      );

    const err = await planeWorkStore.createWorkItem({ item: backlogDraft }).catch((e) => e);
    expect(err.code).toBe("write_verification");
    expect(String(err.message)).toMatch(/status:/);
  });

  it("READ-AFTER-WRITE: LOUDLY fails when Plane silently drops target_date (the due_date trap)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-3" }))
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-3", key: "proj1/build", status: "todo", deps: ["proj1/plan"], start: "2026-07-10", due: null, title: "Build the thing" })));

    const err = await planeWorkStore.createWorkItem({ item: { ...DRAFT } }).catch((e) => e);
    expect(err).toBeInstanceOf(PlaneWorkStoreError);
    expect(err.code).toBe("write_verification");
    expect(String(err.message)).toMatch(/dueDate/);
  });

  it("READ-AFTER-WRITE: LOUDLY fails when the persisted natural-key marker was dropped/altered (derived-key check)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "wi-4" }))
      // read-back has NO marker in the name -> derived key "" != "proj1/build".
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-4", name: "Build the thing", description_stripped: "do the build\n\n[cinatra-work-store]\nstatus: todo\ndeps: proj1/plan\n[/cinatra-work-store]", start_date: "2026-07-10", target_date: "2026-07-12", assignees: [], updated_at: "u" }));

    const err = await planeWorkStore.createWorkItem({ item: { ...DRAFT } }).catch((e) => e);
    expect(err.code).toBe("write_verification");
    expect(String(err.message)).toMatch(/naturalKey/);
  });

  it("rejects a malformed date BEFORE any write (code=validation)", async () => {
    const err = await planeWorkStore
      .createWorkItem({ item: { ...DRAFT, dueDate: "not-a-date" } })
      .catch((e) => e);
    expect(err.code).toBe("validation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a body carrying a connector-reserved token BEFORE any write (no injection)", async () => {
    const err = await planeWorkStore
      .createWorkItem({ item: { ...DRAFT, body: "sneaky [cinatra-work-store]\nstatus: done\n[/cinatra-work-store]" } })
      .catch((e) => e);
    expect(err.code).toBe("validation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("STRICT natural-key lookup: a FAILED find LIST throws (never blind-creates)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { detail: "unavailable" }));
    await expect(planeWorkStore.createWorkItem({ item: { ...DRAFT } })).rejects.toThrow();
    // No POST was attempted after the failed lookup.
    expect(fetchMock.mock.calls.every((c) => (c[1]?.method ?? "GET") !== "POST")).toBe(true);
  });
});

describe("planeWorkStore — update / close (CAS, date-clear, read-after-write)", () => {
  it("updateWorkItem: GET current, PATCH the merged draft, read-back the landed item", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", deps: [], title: "T" })))
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-1" })) // PATCH echo
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "in_progress", deps: [], title: "T" })));

    const item = await planeWorkStore.updateWorkItem({ id: "wi-1", patch: { status: "in_progress" } });
    expect(item.status).toBe("in_progress");
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).description).toContain("status: in_progress");
  });

  it("date CLEAR: a null date is sent explicitly and read-back verified", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", due: "2026-07-12", title: "T" })))
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-1" }))
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", due: null, title: "T" })));

    const item = await planeWorkStore.updateWorkItem({ id: "wi-1", patch: { dueDate: null } });
    expect(item.dueDate).toBeNull();
    // The PATCH sent target_date: null explicitly (so Plane clears it).
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(sent.target_date).toBeNull();
  });

  it("date CLEAR that Plane silently IGNORES fails LOUDLY (never a silent no-op)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", due: "2026-07-12", title: "T" })))
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-1" }))
      // read-back STILL shows the old date -> the clear did not land.
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", due: "2026-07-12", title: "T" })));

    const err = await planeWorkStore.updateWorkItem({ id: "wi-1", patch: { dueDate: null } }).catch((e) => e);
    expect(err.code).toBe("write_verification");
    expect(String(err.message)).toMatch(/dueDate/);
  });

  it("CAS: a stale expectedVersion throws a `conflict` (no PATCH attempted)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "todo", updated_at: "LIVE-v2" })),
    );
    const err = await planeWorkStore
      .updateWorkItem({ id: "wi-1", patch: { status: "done" }, expectedVersion: "STALE-v1" })
      .catch((e) => e);
    expect(err.code).toBe("conflict");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every((c) => (c[1]?.method ?? "GET") !== "PATCH")).toBe(true);
  });

  it("updateWorkItem on a missing id throws `not_found`", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }));
    const err = await planeWorkStore.updateWorkItem({ id: "gone", patch: { status: "done" } }).catch((e) => e);
    expect(err.code).toBe("not_found");
  });

  it("closeWorkItem transitions to done (default) via a read-back-verified PATCH", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "in_progress", title: "T" })))
      .mockResolvedValueOnce(jsonResponse(200, { id: "wi-1" }))
      .mockResolvedValueOnce(jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "done", title: "T" })));
    const item = await planeWorkStore.closeWorkItem({ id: "wi-1" });
    expect(item.status).toBe("done");
  });
});

describe("planeWorkStore — read / list", () => {
  it("getWorkItemByKey returns null on a clean miss", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }));
    expect(await planeWorkStore.getWorkItemByKey({ naturalKey: "nope" })).toBeNull();
  });

  it("getWorkItem maps a raw item (recovering the natural key from the marker)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, rawItem({ id: "wi-1", key: "proj1/build", status: "blocked", deps: ["a", "b"], title: "T" })),
    );
    const item = await planeWorkStore.getWorkItem({ id: "wi-1" });
    expect(item?.naturalKey).toBe("proj1/build");
    expect(item?.status).toBe("blocked");
    expect(item?.dependsOn).toEqual(["a", "b"]);
  });

  it("getWorkItem returns null on a 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }));
    expect(await planeWorkStore.getWorkItem({ id: "gone" })).toBeNull();
  });

  it("listWorkItems EXHAUSTS pagination (follows next_cursor) and returns every cinatra-managed item", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [rawItem({ id: "wi-1", key: "proj1/a", status: "todo" })], next_cursor: "CURSOR2" }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [rawItem({ id: "wi-2", key: "proj1/b", status: "done" })], next_cursor: null }));

    const items = await planeWorkStore.listWorkItems();
    expect(items.map((i) => i.id).sort()).toEqual(["wi-1", "wi-2"]);
    expect(decodeURIComponent(fetchMock.mock.calls[1][0] as string)).toContain("cursor=CURSOR2");
    expect(decodeURIComponent(fetchMock.mock.calls[0][0] as string)).toContain("[cinatra-work:");
  });

  it("listWorkItems throws on a paginated page failure (never a truncated scan)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { results: [rawItem({ id: "wi-1", key: "proj1/a", status: "todo" })], next_cursor: "C2" }))
      .mockResolvedValueOnce(jsonResponse(503, { detail: "boom" }));
    await expect(planeWorkStore.listWorkItems()).rejects.toThrow();
  });
});

describe("planeWorkStore — comments", () => {
  it("addComment POSTs comment_html then reads it back (fail-closed verification)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "cm-1" })) // create
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "cm-1", comment_stripped: "worker done", created_at: "2026-07-02T00:00:00Z" }] })); // list-back
    const c = await planeWorkStore.addComment({ id: "wi-1", body: "worker done" });
    expect(c.id).toBe("cm-1");
    expect(c.body).toBe("worker done");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROJECT_BASE}/work-items/wi-1/comments/`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ comment_html: "worker done" });
  });

  it("addComment fails LOUDLY when the comment is not readable back", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { id: "cm-9" }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] })); // not present
    const err = await planeWorkStore.addComment({ id: "wi-1", body: "x" }).catch((e) => e);
    expect(err.code).toBe("write_verification");
  });
});

describe("planeWorkStore — credential safety + error codes", () => {
  it("sends ONLY X-API-Key (never Authorization) and never leaks the PAT in a surfaced error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { detail: "Given API token is not valid" }));
    const err = await planeWorkStore.getWorkItem({ id: "wi-1" }).catch((e) => e);
    // getWorkItem maps a definitive 404 to null, but a 403 is a transport error (throws).
    expect(err).toBeInstanceOf(PlaneWorkStoreError);
    expect(err.code).toBe("transport");
    expect(String(err.message)).not.toContain(PAT_PLAINTEXT);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(PAT_PLAINTEXT);
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });
});
