import "server-only";

// Plane PM provider implementation of the provider-agnostic `PmConnector`
// contract (cinatra#317, merged #366). Maps the cinatra-shape PmTriggerTask to
// Plane's REST work-item endpoints, scoping every op to the configured
// /workspaces/{slug}/projects/{projectId}/.
//
// CONTRACT (packages/sdk-extensions/src/pm-connector-contract.ts, merged):
//   - upsertTriggerTask({ task, existingTaskId }) -> PmTaskRef
//   - deleteTriggerTask({ runId, externalTaskId }) -> void
// The HOST owns the runId<->externalTaskId link table (pm-link); it passes
// `existingTaskId` in and persists the returned `PmTaskRef.externalTaskId`. The
// connector therefore does NOT keep its own runId->taskId mapping. It only
// resolves the live instance config + decrypts the PAT in-process and attaches
// X-API-Key (the SOLE authenticator, smoke-proven).
//
// NATURAL-KEY IDEMPOTENCY (REQUIRED — load-bearing, codex#317): the natural key
// of a mirrored task is `task.runId`. On a null-id upsert the connector MUST
// find-or-create BY runId — never blind-create — because a slow first push can
// create the upstream item AFTER the host's bounded timeout rejected the await;
// the host then re-syncs with existingTaskId=null and a blind-create provider
// would orphan a permanent duplicate. So every item carries a stable searchable
// title marker `[cinatra:<runId>]`; a null-id upsert looks the marker up first
// and updates the surviving match, re-establishing the link.
//
// DATE SAFETY (smoke-proven, non-negotiable): Plane REST accepts start_date /
// target_date (YYYY-MM-DD) and SILENTLY DROPS due_date (201 with the date gone,
// no error). This connector NEVER sends due_date and ALWAYS asserts the echoed
// target_date after a write — a dropped date is surfaced as a loud error instead
// of silent data loss.

import type {
  PmConnector,
  PmTriggerTask,
  PmTaskRef,
} from "@cinatra-ai/sdk-extensions";

import { planeRest, PlaneRestError } from "./plane-rest-call";

const PROVIDER_ID = "plane";

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
};

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

/** Stable, searchable marker embedded in the work-item title so a null-id
 *  upsert can find an item already created for the same runId (natural-key
 *  idempotency) and concurrent first-creates are discoverable + dedupable on
 *  Plane (the only cross-process coordination point we have without a host
 *  lock). */
function runMarker(runId: string): string {
  return `[cinatra:${runId}]`;
}

/** Compose the Plane work-item title from the trigger fields. */
function composeTitle(task: PmTriggerTask): string {
  const label = `cinatra run ${task.runId}`;
  // Append the marker so it survives + stays greppable for find-by-runId.
  return `${label} ${runMarker(task.runId)}`;
}

/** Compose the Plane work-item description from the trigger metadata. */
function composeDescription(task: PmTriggerTask): string {
  const parts: string[] = [`cinatra run ${task.runId}`, `trigger: ${task.triggerType}`];
  if (task.cronExpression) parts.push(`cron: ${task.cronExpression}`);
  if (task.scheduledAt) parts.push(`scheduled: ${task.scheduledAt}`);
  if (task.timezone) parts.push(`tz: ${task.timezone}`);
  if (task.enabled === false) parts.push("(trigger disabled)");
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

/** The body sent to Plane for both CREATE and PATCH (never due_date). */
function workItemBody(task: PmTriggerTask, calendarDate: string | null): Record<string, unknown> {
  return {
    name: composeTitle(task),
    description: composeDescription(task),
    // The trigger's next-fire instant is mirrored as both start_date and
    // target_date (Plane requires start_date <= target_date; day granularity).
    // NEVER due_date — only target_date/start_date (smoke-proven).
    ...(calendarDate !== null ? { start_date: calendarDate, target_date: calendarDate } : {}),
  };
}

function toTaskRef(item: PlaneWorkItem): PmTaskRef {
  return { externalTaskId: item.id, providerId: PROVIDER_ID };
}

// ---------------------------------------------------------------------------
// Connector implementation
// ---------------------------------------------------------------------------
export const planeConnector: PmConnector = {
  providerId: PROVIDER_ID,

  async upsertTriggerTask(input: {
    task: PmTriggerTask;
    existingTaskId: string | null;
  }): Promise<PmTaskRef> {
    const { task, existingTaskId } = input;
    const calendarDate = toCalendarDate(task.scheduledAt ?? null);

    // UPDATE path — the host gave us the previously-persisted external id. PATCH
    // it directly (smoke-proven PATCH target_date -> 200). If it vanished
    // upstream (deleted out-of-band), fall through to the find-or-create path.
    if (existingTaskId) {
      try {
        const updated = await planeRest<PlaneWorkItem>(
          "PATCH",
          `/work-items/${encodeURIComponent(existingTaskId)}/`,
          workItemBody(task, calendarDate),
        );
        if (!updated) {
          throw new PlaneRestError(500, "Plane PATCH work-item returned no body");
        }
        assertEchoedDate(calendarDate, updated.target_date, "target_date");
        return toTaskRef(updated);
      } catch (err) {
        if (err instanceof PlaneRestError && err.status === 404) {
          // The mirrored item was deleted upstream — re-establish it via the
          // find-or-create path below (re-creates if deleted upstream, per the
          // contract). Any other error propagates.
        } else {
          throw err;
        }
      }
    }

    // FIND-OR-CREATE path (null existingTaskId, OR a 404'd existing id).
    //
    // NATURAL-KEY IDEMPOTENCY: never blind-create. First look up by the runId
    // marker — a prior (possibly timed-out-at-the-host) push may have already
    // created the item. If found, PATCH the surviving match and return its real
    // id, re-establishing the host link instead of orphaning a duplicate.
    const found = await findByRunMarker(task.runId);
    if (found) {
      const updated = await planeRest<PlaneWorkItem>(
        "PATCH",
        `/work-items/${encodeURIComponent(found.id)}/`,
        workItemBody(task, calendarDate),
      );
      if (!updated) {
        throw new PlaneRestError(500, "Plane PATCH work-item returned no body");
      }
      assertEchoedDate(calendarDate, updated.target_date, "target_date");
      return toTaskRef(updated);
    }

    // No existing item for this runId — CREATE (smoke-proven CREATE -> 201,
    // both dates echoed).
    const created = await planeRest<PlaneWorkItem>(
      "POST",
      `/work-items/`,
      workItemBody(task, calendarDate),
    );
    if (!created || !created.id) {
      throw new PlaneRestError(500, "Plane CREATE work-item returned no id");
    }
    assertEchoedDate(calendarDate, created.target_date, "target_date");

    // Lock-free duplicate reconcile WITHOUT a host lock. The host link table is
    // the source of truth for a run's external id, but a SIMULTANEOUS pair of
    // null-id first-pushes (e.g. a retried push whose first attempt timed out at
    // the host but still created the item) can race past the find-by-marker
    // check above and BOTH create an item. We converge: list the marked items,
    // adopt the lexicographically-smallest id as the survivor (both racers
    // compute the same survivor, so they AGREE without coordinating) and delete
    // the rest. Best-effort — if the list call is unavailable we keep our own
    // create (a rare cosmetic duplicate a later upsert re-reconciles; the PM
    // mirror is explicitly best-effort/fail-open, no cinatra data loss).
    const survivor = await reconcileRunTaskDuplicates(task.runId, created);
    return toTaskRef(survivor);
  },

  async deleteTriggerTask(input: { runId: string; externalTaskId: string }): Promise<void> {
    const { externalTaskId } = input;
    if (!externalTaskId) return; // idempotent — nothing to delete.
    try {
      // Smoke-proven DELETE -> 204; subsequent READ -> 404.
      await planeRest("DELETE", `/work-items/${encodeURIComponent(externalTaskId)}/`);
    } catch (err) {
      // A 404 means it's already gone — idempotent success, not an error.
      if (!(err instanceof PlaneRestError && err.status === 404)) {
        throw err;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// List existing work items carrying this run's title marker (natural-key
// lookup). STRICT: a list/search FAILURE propagates (it does NOT mean "no
// match"). This is load-bearing for the contract's REQUIRED "find-or-create by
// runId, NEVER blind-create": treating a lookup failure as a confirmed empty
// set could mask an item a prior (timed-out-at-host) push already created and
// then orphan a permanent duplicate. The host bridge is fail-open — a thrown
// upsert is logged + recorded so the reconcile loop (#318) retries — so failing
// the lookup is SAFE and correct, whereas a blind-create is not.
// ---------------------------------------------------------------------------
type PlaneListResponse = { results?: PlaneWorkItem[] } | PlaneWorkItem[];

async function listByRunMarker(runId: string): Promise<PlaneWorkItem[]> {
  const marker = runMarker(runId);
  // Plane's list supports a `search` param; we also match defensively
  // client-side so a server that ignores `search` still dedups correctly. NO
  // catch here — a failed list MUST surface (see the strict-lookup rationale
  // above); the caller decides whether the failure is fatal (find path) or
  // tolerable (post-create reconcile).
  const list = await planeRest<PlaneListResponse>(
    "GET",
    `/work-items/?search=${encodeURIComponent(marker)}&per_page=100`,
  );
  const rows = Array.isArray(list) ? list : (list?.results ?? []);
  return rows.filter((w) => w.id && (w.name ?? "").includes(marker));
}

/**
 * STRICT natural-key find: returns the deterministic survivor (smallest id)
 * among the run's marked items, or null ONLY when the lookup SUCCEEDED and
 * found nothing. A lookup FAILURE throws — the caller (upsert) must not
 * blind-create on an unconfirmed empty set (contract: never blind-create).
 */
async function findByRunMarker(runId: string): Promise<PlaneWorkItem | null> {
  const matches = await listByRunMarker(runId);
  if (matches.length === 0) return null;
  // Deterministic survivor: smallest id (both racing writers agree).
  return matches.reduce((min, w) => (w.id < min.id ? w : min));
}

// ---------------------------------------------------------------------------
// Lock-free duplicate reconcile: converge concurrent first-creates for the same
// runId onto a single survivor (lexicographically-smallest id among all Plane
// work items carrying this run's marker). BOTH racing writers compute the same
// survivor, so they agree without coordinating; every other duplicate is
// deleted. Best-effort — if the list call is unavailable we keep `created`.
// ---------------------------------------------------------------------------
async function reconcileRunTaskDuplicates(
  runId: string,
  created: PlaneWorkItem,
): Promise<PlaneWorkItem> {
  // Best-effort: a failed reconcile LIST keeps our own create (the item was
  // already successfully created; a rare cosmetic duplicate is re-reconciled by
  // the next upsert). This is the ONLY place a marker-list failure is tolerated
  // — the primary natural-key find (findByRunMarker) is strict.
  let matches: PlaneWorkItem[];
  try {
    matches = await listByRunMarker(runId);
  } catch {
    return created;
  }
  const byId = new Map<string, PlaneWorkItem>();
  for (const w of matches) byId.set(w.id, w);
  // Always include our own create (the list may lag our just-created row).
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
