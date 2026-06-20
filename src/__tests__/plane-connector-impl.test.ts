// plane-connector impl tests — exercise the PmConnector verbs against a mocked
// fetch, asserting the SMOKE-PROVEN contract:
//   - X-API-Key is the SOLE auth header sent (never Authorization: Bearer).
//   - work-item CRUD scopes to /workspaces/{slug}/projects/{projectId}/work-items/.
//   - dates use start_date/target_date (never due_date), and a SILENTLY DROPPED
//     target_date is surfaced as a loud error (the due_date trap).
//   - lock-free duplicate reconcile converges concurrent creates onto one survivor.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planeConnector } from "../plane-connector";
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

let taskMap: Map<string, string>;

function buildDeps(): PlaneConnectorHostDeps {
  return {
    secretsCodec: {
      encryptSecret: (plaintext) => ({ ciphertext: plaintext, iv: "iv" }),
      decryptSecret: () => PAT_PLAINTEXT,
    },
    loadInstanceConfig: async () => INSTANCE,
    saveInstanceConfig: async () => {},
    loadRunTaskId: async (runId) => taskMap.get(runId) ?? null,
    saveRunTaskId: async (runId, taskId) => {
      taskMap.set(runId, taskId);
    },
    deleteRunTaskId: async (runId) => {
      taskMap.delete(runId);
    },
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  taskMap = new Map();
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

describe("planeConnector — auth + work-item CRUD (smoke-proven)", () => {
  it("upsertRunTask CREATE sends X-API-Key only, scopes the URL, uses start_date/target_date, embeds the runId marker", async () => {
    fetchMock
      // 1) CREATE -> 201
      .mockResolvedValueOnce(
        jsonResponse(201, {
          id: "wi-1",
          name: "cinatra run r1 [cinatra:r1]",
          start_date: "2026-06-20",
          target_date: "2026-06-20",
          state: "backlog",
        }),
      )
      // 2) reconcile LIST -> only our own item (no duplicate)
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ id: "wi-1", name: "cinatra run r1 [cinatra:r1]" }] }),
      );

    const task = await planeConnector.upsertRunTask({
      runId: "r1",
      triggerType: "scheduled",
      scheduledAt: "2026-06-20T09:00:00.000Z",
      timezone: "UTC",
      enabled: true,
    });

    expect(task.id).toBe("wi-1");
    expect(task.dueDate).toBe("2026-06-20");

    // Inspect the CREATE request.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:3400/api/v1/workspaces/cinatra-smoke/projects/9e051c95-7408-4d4e-896e-c714e02e5713/work-items/",
    );
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
    // The runId→taskId mapping was persisted.
    expect(taskMap.get("r1")).toBe("wi-1");
  });

  it("upsertRunTask UPDATE PATCHes the existing work item when a mapping exists (no reconcile)", async () => {
    taskMap.set("r1", "wi-1");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "wi-1",
        name: "cinatra run r1 [cinatra:r1]",
        target_date: "2026-06-25",
      }),
    );

    const task = await planeConnector.upsertRunTask({
      runId: "r1",
      triggerType: "scheduled",
      scheduledAt: "2026-06-25T09:00:00.000Z",
      timezone: "UTC",
    });

    expect(task.dueDate).toBe("2026-06-25");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/work-items/wi-1/");
    expect(init.method).toBe("PATCH");
    // UPDATE path makes exactly one call — no reconcile LIST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("LOUDLY fails when Plane silently drops target_date (the due_date trap)", async () => {
    // 201 but target_date comes back null — fail BEFORE the reconcile.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { id: "wi-2", name: "x [cinatra:r2]", target_date: null }),
    );

    await expect(
      planeConnector.upsertRunTask({
        runId: "r2",
        triggerType: "scheduled",
        scheduledAt: "2026-07-01T09:00:00.000Z",
        timezone: "UTC",
      }),
    ).rejects.toThrow(/silently dropped target_date/i);
  });

  it("deleteRunTask DELETEs the mapped work item and drops the mapping (idempotent)", async () => {
    taskMap.set("r3", "wi-3");
    fetchMock.mockResolvedValueOnce(jsonResponse(204, null));

    await planeConnector.deleteRunTask({ runId: "r3" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/work-items/wi-3/");
    expect(init.method).toBe("DELETE");
    expect(taskMap.has("r3")).toBe(false);

    // Second call is a no-op (no mapping) — no fetch.
    fetchMock.mockClear();
    await planeConnector.deleteRunTask({ runId: "r3" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getRunTask reads the mapped work item, returns null + drops mapping on 404", async () => {
    taskMap.set("r4", "wi-4");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { id: "wi-4", name: "x", target_date: "2026-06-20" }),
    );
    const task = await planeConnector.getRunTask({ runId: "r4" });
    expect(task?.id).toBe("wi-4");

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "Not found." }));
    const gone = await planeConnector.getRunTask({ runId: "r4" });
    expect(gone).toBeNull();
    expect(taskMap.has("r4")).toBe(false);
  });

  it("rejects a malformed target_date BEFORE the write (strict YYYY-MM-DD)", async () => {
    await expect(
      planeConnector.upsertRunTask({
        runId: "r5",
        triggerType: "scheduled",
        scheduledAt: "not-a-date",
        timezone: "UTC",
      }),
    ).rejects.toThrow(/invalid calendar date/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("concurrency reconcile: converges on the lexicographically-smallest survivor and deletes duplicates", async () => {
    // Our create returns "wi-zzz"; the reconcile LIST reveals a concurrent
    // duplicate "wi-aaa". The deterministic survivor is min id = "wi-aaa", so
    // OUR "wi-zzz" must be DELETEd and "wi-aaa" adopted as the mapping.
    fetchMock
      // 1) CREATE -> 201 (our id, the larger one)
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-zzz", name: "run [cinatra:rc]", target_date: "2026-06-20" }),
      )
      // 2) reconcile LIST -> both duplicates carry the marker
      .mockResolvedValueOnce(
        jsonResponse(200, {
          results: [
            { id: "wi-aaa", name: "run [cinatra:rc]" },
            { id: "wi-zzz", name: "run [cinatra:rc]" },
          ],
        }),
      )
      // 3) DELETE our non-survivor "wi-zzz" -> 204
      .mockResolvedValueOnce(jsonResponse(204, null));

    const task = await planeConnector.upsertRunTask({
      runId: "rc",
      triggerType: "scheduled",
      scheduledAt: "2026-06-20T09:00:00.000Z",
      timezone: "UTC",
    });

    // Survivor is the smallest id, deterministically.
    expect(task.id).toBe("wi-aaa");
    expect(taskMap.get("rc")).toBe("wi-aaa");
    // The 3rd call deleted OUR duplicate (the non-survivor).
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
    expect(fetchMock.mock.calls[2][0]).toContain("/work-items/wi-zzz/");
  });

  it("reconcile is best-effort: a failed LIST keeps our own create (single happy path unaffected)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(201, { id: "wi-solo", name: "run [cinatra:rs]", target_date: "2026-06-20" }),
      )
      // reconcile LIST fails -> keep our create
      .mockResolvedValueOnce(jsonResponse(500, { detail: "boom" }));

    const task = await planeConnector.upsertRunTask({
      runId: "rs",
      triggerType: "scheduled",
      scheduledAt: "2026-06-20T09:00:00.000Z",
      timezone: "UTC",
    });
    expect(task.id).toBe("wi-solo");
    expect(taskMap.get("rs")).toBe("wi-solo");
  });

  it("surfaces a 403 invalid-key/non-member/bogus-project as a PlaneRestError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { detail: "Given API token is not valid" }),
    );
    await expect(
      planeConnector.upsertRunTask({
        runId: "r6",
        triggerType: "immediate",
        timezone: "UTC",
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
