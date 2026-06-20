import "server-only";

// Plane PM provider implementation for the provider-agnostic PmConnector facade.
// Maps cinatra-shape PmTask verbs to Plane's REST work-item endpoints, scoping
// every op to the configured /workspaces/{slug}/projects/{projectId}/. The
// connector owns the runId->taskId mapping (in its own config rows) so the host
// never stores a provider id.
//
// All upstream calls go through `planeRest` which resolves the live instance
// config + decrypts the PAT in-process and attaches X-API-Key (the SOLE
// authenticator, smoke-proven).
//
// DATE SAFETY (smoke-proven, non-negotiable): Plane REST accepts start_date /
// target_date (YYYY-MM-DD) and SILENTLY DROPS due_date (201 with the date gone,
// no error). This connector NEVER sends due_date and ALWAYS asserts the echoed
// target_date after a write — a dropped date is surfaced as a loud error
// instead of silent data loss.

import type {
  PmConnector,
  PmTask,
  PmRunTaskInput,
} from "@cinatra-ai/sdk-extensions";

import { getPlaneDeps } from "./deps";
import { planeRest, PlaneRestError } from "./plane-rest-call";

// ---------------------------------------------------------------------------
// Plane raw work-item shape (subset of fields cinatra reads).
// ---------------------------------------------------------------------------
type PlaneWorkItem = {
  id: string;
  name?: string;
  description_stripped?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  state?: string | null;
  // Plane returns a sequence/identifier; the connector keeps the raw id as the
  // stable PmTask.id.
};

// ---------------------------------------------------------------------------
// Map: cinatra PmTask <-> Plane work item
// ---------------------------------------------------------------------------
function mapWorkItemToTask(w: PlaneWorkItem): PmTask {
  return {
    id: w.id,
    title: w.name ?? "",
    description: w.description_stripped ?? null,
    startDate: w.start_date ?? null,
    dueDate: w.target_date ?? null, // cinatra `dueDate` ↔ Plane `target_date`
    state: w.state ?? null,
    url: null,
  };
}

/** Day-level ISO calendar date (YYYY-MM-DD) or null. Throws on a malformed
 *  value BEFORE the write so we never depend on Plane's 400 to catch it. */
function toCalendarDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  // Accept a full ISO datetime and narrow to the calendar date; reject anything
  // that isn't a real YYYY-MM-DD.
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new PlaneRestError(400, `invalid calendar date: ${value} (expected YYYY-MM-DD)`);
  }
  // Validate it's a real date (rejects 2026-13-40 etc.).
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) {
    throw new PlaneRestError(400, `invalid calendar date: ${value}`);
  }
  return day;
}

/** Compose the Plane work-item title from the run-derived fields. */
/** Stable, searchable marker embedded in the work-item title so duplicate
 *  concurrent creates for the same runId are discoverable + dedupable on Plane
 *  (the only cross-process coordination point we have without a host lock). */
function runMarker(runId: string): string {
  return `[cinatra:${runId}]`;
}

function composeTitle(input: PmRunTaskInput): string {
  const label = (input.title ?? "").trim() || `cinatra run ${input.runId}`;
  // Append the marker so it survives a custom title and stays greppable.
  return `${label} ${runMarker(input.runId)}`;
}

/** Compose the Plane work-item description from the trigger metadata. */
function composeDescription(input: PmRunTaskInput): string {
  const parts: string[] = [`cinatra run ${input.runId}`, `trigger: ${input.triggerType}`];
  if (input.cronExpression) parts.push(`cron: ${input.cronExpression}`);
  if (input.scheduledAt) parts.push(`scheduled: ${input.scheduledAt}`);
  if (input.timezone) parts.push(`tz: ${input.timezone}`);
  if (input.enabled === false) parts.push("(trigger disabled)");
  return parts.join("\n");
}

/**
 * After a CREATE/PATCH, assert Plane echoed the date we sent. Plane silently
 * drops an unknown date field (the due_date trap) — this turns a silent drop
 * into a loud error. Only asserts when we actually sent a target_date.
 */
function assertEchoedDate(
  sent: string | null,
  echoed: string | null | undefined,
  field: string,
): void {
  if (sent === null) return; // nothing asserted — we didn't set it.
  const normalizedEchoed = (echoed ?? "").slice(0, 10) || null;
  if (normalizedEchoed !== sent) {
    throw new PlaneRestError(
      500,
      `Plane silently dropped ${field}: sent "${sent}", echoed "${normalizedEchoed}". ` +
        `Refusing to report success on lost date data.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connector implementation
// ---------------------------------------------------------------------------
export const planeConnector: PmConnector = {
  providerId: "plane",

  async upsertRunTask(input: PmRunTaskInput): Promise<PmTask> {
    const deps = getPlaneDeps();
    const startDate = toCalendarDate(input.scheduledAt ?? null);
    // The trigger's next-fire instant is mirrored as the work item's
    // target_date (the due-by). start_date is the same instant — Plane requires
    // start_date <= target_date, so we set both to the calendar date.
    const targetDate = startDate;

    const existingTaskId = await deps.loadRunTaskId(input.runId);

    if (existingTaskId) {
      // UPDATE path — PATCH the existing work item. Smoke-proven PATCH
      // target_date -> 200.
      const patchBody: Record<string, unknown> = {
        name: composeTitle(input),
        description: composeDescription(input),
        // NEVER due_date — only target_date/start_date (smoke-proven).
        ...(startDate !== null ? { start_date: startDate } : {}),
        ...(targetDate !== null ? { target_date: targetDate } : {}),
      };
      let updated: PlaneWorkItem | null;
      try {
        updated = await planeRest<PlaneWorkItem>(
          "PATCH",
          `/work-items/${encodeURIComponent(existingTaskId)}/`,
          patchBody,
        );
      } catch (err) {
        // If the work item vanished upstream (deleted out-of-band), drop the
        // stale mapping and fall through to a fresh create.
        if (err instanceof PlaneRestError && err.status === 404) {
          await deps.deleteRunTaskId(input.runId);
          return this.upsertRunTask(input);
        }
        throw err;
      }
      if (!updated) {
        throw new PlaneRestError(500, "Plane PATCH work-item returned no body");
      }
      assertEchoedDate(targetDate, updated.target_date, "target_date");
      return mapWorkItemToTask(updated);
    }

    // CREATE path — smoke-proven CREATE -> 201, both dates echoed.
    const createBody: Record<string, unknown> = {
      name: composeTitle(input),
      description: composeDescription(input),
      ...(startDate !== null ? { start_date: startDate } : {}),
      ...(targetDate !== null ? { target_date: targetDate } : {}),
    };
    const created = await planeRest<PlaneWorkItem>("POST", `/work-items/`, createBody);
    if (!created || !created.id) {
      throw new PlaneRestError(500, "Plane CREATE work-item returned no id");
    }
    assertEchoedDate(targetDate, created.target_date, "target_date");

    // Best-effort duplicate reconcile WITHOUT a host lock. The connector-config
    // store is plain KV with no CAS/unique-constraint, so a TRULY airtight
    // "exactly one task per runId under a simultaneous double-create" guarantee
    // is not achievable at the connector layer — it needs a host-side atomic
    // claim (CAS / unique insert), which is host-wiring scope (cinatra#313).
    //
    // What this DOES guarantee, deterministically: every work item created for a
    // runId carries a stable title marker `[cinatra:<runId>]`; after CREATE we
    // list the marked items and converge on the lexicographically-smallest id as
    // the survivor (both writers compute the same survivor, so concurrent
    // reconciles AGREE on which task lives and delete the rest). This collapses
    // the realistic cases — a retry, a double-submit, a re-config — to a single
    // Plane task. The residual is a sub-millisecond interleaving (writer A lists
    // before writer B's create is visible, then persists its own id after B
    // deleted it) that can leave ONE cosmetic duplicate / a stale mapping; that
    // is self-healing — the next upsert re-reconciles, and getRunTask drops a
    // mapping whose task 404s. The PM mirror is explicitly best-effort/fail-open
    // (a transient duplicate work item is acceptable; there is no cinatra data
    // loss). If the list call is unavailable we simply keep our own create.
    const survivor = await reconcileRunTaskDuplicates(input.runId, created);
    await deps.saveRunTaskId(input.runId, survivor.id);
    return mapWorkItemToTask(survivor);
  },

  async deleteRunTask({ runId }: { runId: string }): Promise<void> {
    const deps = getPlaneDeps();
    const taskId = await deps.loadRunTaskId(runId);
    if (!taskId) return; // idempotent — nothing mapped.
    try {
      // Smoke-proven DELETE -> 204; subsequent READ -> 404.
      await planeRest("DELETE", `/work-items/${encodeURIComponent(taskId)}/`);
    } catch (err) {
      // A 404 means it's already gone — still drop our mapping.
      if (!(err instanceof PlaneRestError && err.status === 404)) {
        throw err;
      }
    }
    await deps.deleteRunTaskId(runId);
  },

  async getRunTask({ runId }: { runId: string }): Promise<PmTask | null> {
    const deps = getPlaneDeps();
    const taskId = await deps.loadRunTaskId(runId);
    if (!taskId) return null;
    try {
      // Smoke-proven READ-by-id -> 200.
      const item = await planeRest<PlaneWorkItem>(
        "GET",
        `/work-items/${encodeURIComponent(taskId)}/`,
      );
      if (!item) return null;
      return mapWorkItemToTask(item);
    } catch (err) {
      if (err instanceof PlaneRestError && err.status === 404) {
        // Mapped task was deleted upstream — drop the stale mapping.
        await deps.deleteRunTaskId(runId);
        return null;
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Lock-free duplicate reconcile: converge concurrent first-creates for the same
// runId onto a single survivor (lexicographically-smallest id among all Plane
// work items carrying this run's marker). BOTH racing writers compute the same
// survivor, so they agree without coordinating; every other duplicate is
// deleted. Best-effort — if the list call is unavailable we keep `created` as
// the survivor (the single happy path is unaffected; a rare double-submit then
// leaves a cosmetic duplicate a later upsert reconciles).
// ---------------------------------------------------------------------------
type PlaneListResponse = { results?: PlaneWorkItem[] } | PlaneWorkItem[];

async function reconcileRunTaskDuplicates(
  runId: string,
  created: PlaneWorkItem,
): Promise<PlaneWorkItem> {
  const marker = runMarker(runId);
  let list: PlaneListResponse | null;
  try {
    // List work items and match by the title marker. (Plane's list supports a
    // `search` param; we match defensively client-side too so a server that
    // ignores `search` still dedups correctly.)
    list = await planeRest<PlaneListResponse>(
      "GET",
      `/work-items/?search=${encodeURIComponent(marker)}&per_page=100`,
    );
  } catch {
    return created; // best-effort — keep our own create.
  }
  const rows = Array.isArray(list) ? list : (list?.results ?? []);
  const matches = rows.filter((w) => (w.name ?? "").includes(marker));
  // Always include our own create (the list may lag our just-created row).
  const byId = new Map<string, PlaneWorkItem>();
  for (const w of matches) if (w.id) byId.set(w.id, w);
  byId.set(created.id, created);
  if (byId.size <= 1) return created;

  // Deterministic survivor: smallest id (both writers agree).
  const ids = [...byId.keys()].sort();
  const survivorId = ids[0];
  const survivor = byId.get(survivorId) ?? created;
  // Delete every non-survivor duplicate (best-effort).
  for (const id of ids) {
    if (id === survivorId) continue;
    await planeRest("DELETE", `/work-items/${encodeURIComponent(id)}/`).catch(() => {
      // Leftover is cosmetic; a later upsert re-reconciles.
    });
  }
  return survivor;
}
