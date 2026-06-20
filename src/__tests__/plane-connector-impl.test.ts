// plane-connector impl tests — exercise the merged PmConnector contract (#366)
// against a mocked fetch, asserting the SMOKE-PROVEN wire facts:
//   - upsertTriggerTask({ task, existingTaskId }) -> PmTaskRef
//   - deleteTriggerTask({ runId, externalTaskId }) -> void
//   - X-API-Key is the SOLE auth header sent (never Authorization: Bearer).
//   - work-item CRUD scopes to /workspaces/{slug}/projects/{projectId}/work-items/.
//   - dates use start_date/target_date (never due_date), and a SILENTLY DROPPED
//     target_date is surfaced as a loud error (the due_date trap).
//   - NATURAL-KEY IDEMPOTENCY: a null-id upsert finds an existing item by the
//     `[cinatra:<runId>]` marker (find-or-create), never blind-creating a
//     duplicate; concurrent first-creates converge on one survivor.
//   - the HOST owns the runId<->externalTaskId link — the connector keeps NO
//     local mapping (existingTaskId is passed IN; PmTaskRef is returned).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// `planeConnectorImpl` is the local-typed impl exposing `readTriggerTask`
// statically even on `main` (where the SDK `PmConnector` does not yet declare
// it — cinatra#319 landing order). `planeConnector` is the widened export.
import { planeConnector, planeConnectorImpl } from "../plane-connector";
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

const TASK = {
  runId: "r1",
  triggerType: "scheduled" as const,
  scheduledAt: "2026-06-20T09:00:00.000Z" as string | null,
  cronExpression: null as string | null,
  timezone: "UTC",
  enabled: true,
};

describe("planeConnector — merged PmConnector contract + smoke-proven wire", () => {
  it("upsertTriggerTask first push (null id) find-or-creates: GET-by-marker miss → CREATE, X-API-Key only, scoped URL, start_date/target_date, marker, returns PmTaskRef", async () => {
    fetchMock
      // 1) find-by-marker LIST -> no existing item for this runId
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      // 2) CREATE -> 201
      .mockResolvedValueOnce(
        jsonResponse(201, {
          id: "wi-1",
          name: "cinatra run r1 [cinatra:r1]",
          start_date: "2026-06-20",
          target_date: "2026-06-20",
          state: "backlog",
        }),
      )
      // 3) reconcile LIST -> only our own item (no duplicate)
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "wi-1", name: "cinatra run r1 [cinatra:r1]" }] }),
      );

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK },
      existingTaskId: null,
    });

    // Returns the PmTaskRef the host persists in the pm-link row.
    expect(ref.externalTaskId).toBe("wi-1");
    expect(ref.providerId).toBe("plane");

    // 1st fetch is the find-by-marker LIST (GET, search marker).
    {
      const [url, init] = fetchMock.mock.calls[0];
      expect(init.method ?? "GET").toBe("GET");
      expect(url).toContain(`${PROJECT_BASE}/work-items/?search=`);
      expect(decodeURIComponent(url)).toContain("[cinatra:r1]");
    }

    // 2nd fetch is the CREATE.
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${PROJECT_BASE}/work-items/`);
    expect(init.method).toBe("POST");
    // SOLE authenticator — X-API-Key present, NO Authorization header.
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(PAT_PLAINTEXT);
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    // Body uses start_date/target_date, NEVER due_date; title carries the marker.
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.start_date).toBe("2026-06-20");
    expect(sentBody.target_date).toBe("2026-06-20");
    expect("due_date" in sentBody).toBe(false);
    expect(sentBody.name).toContain("[cinatra:r1]");
  });

  it("upsertTriggerTask with an existingTaskId PATCHes that item directly (no find-by-marker, no reconcile)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "wi-1",
        name: "cinatra run r1 [cinatra:r1]",
        target_date: "2026-06-25",
      }),
    );

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK, scheduledAt: "2026-06-25T09:00:00.000Z" },
      existingTaskId: "wi-1",
    });

    expect(ref.externalTaskId).toBe("wi-1");
    expect(ref.providerId).toBe("plane");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROJECT_BASE}/work-items/wi-1/`);
    expect(init.method).toBe("PATCH");
    // UPDATE path makes exactly one call — no find-by-marker, no reconcile LIST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("upsertTriggerTask re-creates when the existingTaskId 404s (PATCH→404 then find-or-create)", async () => {
    fetchMock
      // 1) PATCH existing id -> 404 (deleted upstream)
      .mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }))
      // 2) find-by-marker LIST -> none
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      // 3) CREATE -> 201 (fresh id)
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-new", name: "cinatra run r1 [cinatra:r1]", target_date: "2026-06-20" }),
      )
      // 4) reconcile LIST -> only our own
      .mockResolvedValueOnce(jsonResponse(200, { results: [{ id: "wi-new", name: "x [cinatra:r1]" }] }));

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK },
      existingTaskId: "wi-gone",
    });

    expect(ref.externalTaskId).toBe("wi-new");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(fetchMock.mock.calls[0][0]).toContain("/work-items/wi-gone/");
  });

  it("NATURAL-KEY IDEMPOTENCY: a null-id upsert that finds an existing item by marker PATCHes it (never blind-creates a duplicate)", async () => {
    fetchMock
      // 1) find-by-marker LIST -> a prior (timed-out-at-host) push already created wi-prior
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "wi-prior", name: "cinatra run r1 [cinatra:r1]" }] }),
      )
      // 2) PATCH the surviving match (NOT a create)
      .mockResolvedValueOnce(
        jsonResponse(200, { id: "wi-prior", name: "cinatra run r1 [cinatra:r1]", target_date: "2026-06-20" }),
      );

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK },
      existingTaskId: null,
    });

    // Re-established the link to the prior item; no orphaned duplicate.
    expect(ref.externalTaskId).toBe("wi-prior");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second call is a PATCH to the found id — NOT a POST create.
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
    expect(fetchMock.mock.calls[1][0]).toContain("/work-items/wi-prior/");
  });

  it("STRICT natural-key lookup: a FAILED find-by-marker LIST throws (never blind-creates on an unconfirmed empty set)", async () => {
    // The host bridge is fail-open — a thrown upsert is logged + recorded and
    // the reconcile loop retries — so failing the lookup is correct, whereas a
    // blind POST could orphan a duplicate the prior push already created.
    fetchMock
      // find-by-marker LIST -> 503 (lookup failure, NOT a confirmed no-match)
      .mockResolvedValueOnce(jsonResponse(503, { detail: "service unavailable" }));

    await expect(
      planeConnector.upsertTriggerTask({
        task: { ...TASK, runId: "rfail" },
        existingTaskId: null,
      }),
    ).rejects.toThrow(/HTTP 503/);
    // Crucially: NO create (POST) was attempted after the failed lookup.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every((c) => (c[1]?.method ?? "GET") !== "POST")).toBe(true);
  });

  it("LOUDLY fails when Plane silently drops target_date (the due_date trap)", async () => {
    fetchMock
      // find-by-marker LIST -> none
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      // CREATE 201 but target_date comes back null — fail BEFORE the reconcile.
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-2", name: "x [cinatra:r2]", target_date: null }),
      );

    await expect(
      planeConnector.upsertTriggerTask({
        task: { ...TASK, runId: "r2", scheduledAt: "2026-07-01T09:00:00.000Z" },
        existingTaskId: null,
      }),
    ).rejects.toThrow(/silently dropped target_date/i);
  });

  it("deleteTriggerTask DELETEs the given externalTaskId (idempotent on 404 + empty id)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));

    await planeConnector.deleteTriggerTask({ runId: "r3", externalTaskId: "wi-3" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROJECT_BASE}/work-items/wi-3/`);
    expect(init.method).toBe("DELETE");

    // 404 is treated as already-gone success (no throw).
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }));
    await expect(
      planeConnector.deleteTriggerTask({ runId: "r3", externalTaskId: "wi-3" }),
    ).resolves.toBeUndefined();

    // Empty external id is a no-op (no fetch).
    fetchMock.mockReset();
    await planeConnector.deleteTriggerTask({ runId: "r3", externalTaskId: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed scheduledAt BEFORE any write (strict YYYY-MM-DD)", async () => {
    await expect(
      planeConnector.upsertTriggerTask({
        task: { ...TASK, runId: "r5", scheduledAt: "not-a-date" },
        existingTaskId: null,
      }),
    ).rejects.toThrow(/invalid calendar date/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("concurrency reconcile: converges on the lexicographically-smallest survivor and deletes duplicates", async () => {
    // find-by-marker initially empty; our create returns "wi-zzz"; the reconcile
    // LIST reveals a concurrent duplicate "wi-aaa". Deterministic survivor is
    // min id = "wi-aaa", so OUR "wi-zzz" is DELETEd and "wi-aaa" adopted.
    fetchMock
      // 1) find-by-marker LIST -> none yet
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      // 2) CREATE -> 201 (our id, the larger one)
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-zzz", name: "run [cinatra:rc]", target_date: "2026-06-20" }),
      )
      // 3) reconcile LIST -> both duplicates carry the marker
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            { id: "wi-aaa", name: "run [cinatra:rc]" },
            { id: "wi-zzz", name: "run [cinatra:rc]" },
          ],
        }),
      )
      // 4) DELETE our non-survivor "wi-zzz" -> 204
      .mockResolvedValueOnce(jsonResponse(204, null));

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK, runId: "rc" },
      existingTaskId: null,
    });

    // Survivor is the smallest id, deterministically.
    expect(ref.externalTaskId).toBe("wi-aaa");
    // The 4th call deleted OUR duplicate (the non-survivor).
    expect(fetchMock.mock.calls[3][1].method).toBe("DELETE");
    expect(fetchMock.mock.calls[3][0]).toContain("/work-items/wi-zzz/");
  });

  it("reconcile is best-effort: a failed reconcile LIST keeps our own create", async () => {
    fetchMock
      // find-by-marker LIST -> none
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      // CREATE -> 201
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-solo", name: "run [cinatra:rs]", target_date: "2026-06-20" }),
      )
      // reconcile LIST fails -> keep our create
      .mockResolvedValueOnce(jsonResponse(500, { detail: "boom" }));

    const ref = await planeConnector.upsertTriggerTask({
      task: { ...TASK, runId: "rs" },
      existingTaskId: null,
    });
    expect(ref.externalTaskId).toBe("wi-solo");
  });

  it("surfaces a 403 invalid-key/non-member/bogus-project as a PlaneRestError", async () => {
    // existingTaskId path: PATCH -> 403 propagates (not a 404, so no fallback).
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { detail: "Given API token is not valid" }),
    );
    await expect(
      planeConnector.upsertTriggerTask({
        task: { ...TASK, runId: "r6", triggerType: "immediate", scheduledAt: null },
        existingTaskId: "wi-x",
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  // ---------------------------------------------------------------------------
  // readTriggerTask (cinatra#319 pre-execution PM check) — inbound READ dual.
  // The host maps a clean `null` to "deleted -> tear down" and ANY throw to
  // "unreachable -> fail-open proceed". So `null` is reserved for a clean 404;
  // every other error path MUST throw, never falsely delete a live schedule.
  // ---------------------------------------------------------------------------
  describe("readTriggerTask — fail-open read-back contract", () => {
    it("GETs the scoped work item and maps connector-owned metadata to PmTaskState (recurring: cron + paused)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-1",
          name: "cinatra run r1 [cinatra:r1]",
          description_stripped:
            "cinatra run r1\ntrigger: recurring\ncron: 0 9 * * 1\ntz: UTC\n(trigger disabled)",
          target_date: "2026-06-20",
        }),
      );

      const state = await planeConnectorImpl.readTriggerTask({
        runId: "r1",
        externalTaskId: "wi-1",
      });

      // GET to the project-scoped work-item-by-id endpoint, X-API-Key only.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${PROJECT_BASE}/work-items/wi-1/`);
      expect((init.method ?? "GET")).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe(PAT_PLAINTEXT);
      expect(headers.authorization).toBeUndefined();
      expect(headers.Authorization).toBeUndefined();

      expect(state).not.toBeNull();
      expect(state).toEqual({
        externalTaskId: "wi-1",
        paused: true,
        cronExpression: "0 9 * * 1",
        scheduledAt: "2026-06-20T00:00:00.000Z", // no `scheduled:` line -> target_date fallback
      });
    });

    it("scheduled trigger: prefers the exact `scheduled:` instant (no phantom reschedule vs the local snapshot)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-2",
          name: "cinatra run r2 [cinatra:r2]",
          description_stripped:
            "cinatra run r2\ntrigger: scheduled\nscheduled: 2026-06-20T09:00:00.000Z\ntz: UTC",
          target_date: "2026-06-20",
        }),
      );

      const state = await planeConnectorImpl.readTriggerTask({
        runId: "r2",
        externalTaskId: "wi-2",
      });

      // The exact stamped instant wins over the day-level target_date so the
      // host's scheduled-instant diff stays stable.
      expect(state).toEqual({
        externalTaskId: "wi-2",
        paused: false,
        cronExpression: null,
        scheduledAt: "2026-06-20T09:00:00.000Z",
      });
    });

    it("not paused, no cron, no scheduled line, no target_date -> all null/false", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-3",
          name: "cinatra run r3 [cinatra:r3]",
          description_stripped: "cinatra run r3\ntrigger: immediate\ntz: UTC",
          target_date: null,
        }),
      );

      const state = await planeConnectorImpl.readTriggerTask({
        runId: "r3",
        externalTaskId: "wi-3",
      });
      expect(state).toEqual({
        externalTaskId: "wi-3",
        paused: false,
        cronExpression: null,
        scheduledAt: null,
      });
    });

    it("robust to a FLATTENED (space-joined) description — labels are bounded by the next known label", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          id: "wi-4",
          name: "cinatra run r4 [cinatra:r4]",
          // Plane normalized the newlines to spaces.
          description_stripped:
            "cinatra run r4 trigger: recurring cron: 0 9 * * 1 tz: UTC (trigger disabled)",
          target_date: "2026-06-20",
        }),
      );

      const state = await planeConnectorImpl.readTriggerTask({
        runId: "r4",
        externalTaskId: "wi-4",
      });
      // cron must NOT swallow the trailing `tz:`/marker; paused still detected.
      expect(state).toEqual({
        externalTaskId: "wi-4",
        paused: true,
        cronExpression: "0 9 * * 1",
        scheduledAt: "2026-06-20T00:00:00.000Z",
      });
    });

    it("returns null ONLY on a clean 404 (definitive upstream delete -> host tears down)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }));
      const state = await planeConnectorImpl.readTriggerTask({
        runId: "r5",
        externalTaskId: "wi-gone",
      });
      expect(state).toBeNull();
    });

    it("THROWS on a 403 (auth/authz) — never a false delete (host fail-opens unreachable)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(403, { detail: "Given API token is not valid" }),
      );
      await expect(
        planeConnectorImpl.readTriggerTask({ runId: "r6", externalTaskId: "wi-6" }),
      ).rejects.toThrow(/HTTP 403/);
    });

    it("THROWS on a 5xx outage — never a false delete", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(503, { detail: "unavailable" }));
      await expect(
        planeConnectorImpl.readTriggerTask({ runId: "r7", externalTaskId: "wi-7" }),
      ).rejects.toThrow(/HTTP 503/);
    });

    it("THROWS on a network failure (fetch reject -> PlaneRestError status 0) — never a false delete", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(
        planeConnectorImpl.readTriggerTask({ runId: "r8", externalTaskId: "wi-8" }),
      ).rejects.toThrow(/upstream fetch failed/i);
    });

    it("THROWS on a 200 with an empty/idless body — not a definitive delete", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: "no id here" }));
      await expect(
        planeConnectorImpl.readTriggerTask({ runId: "r9", externalTaskId: "wi-9" }),
      ).rejects.toThrow(/no body\/id/i);
    });

    it("THROWS on an empty externalTaskId (host invariant break, not a delete) — no fetch", async () => {
      await expect(
        planeConnectorImpl.readTriggerTask({ runId: "r10", externalTaskId: "" }),
      ).rejects.toThrow(/empty externalTaskId/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
