import "server-only";

// Plane PM provider implementation of the provider-agnostic `PmConnector`
// contract (cinatra#317, merged #366). Maps the cinatra-shape PmTriggerTask to
// Plane's REST work-item endpoints, scoping every op to the configured
// /workspaces/{slug}/projects/{projectId}/.
//
// CONTRACT (packages/sdk-extensions/src/pm-connector-contract.ts, merged):
//   - upsertTriggerTask({ task, existingTaskId }) -> PmTaskRef
//   - deleteTriggerTask({ runId, externalTaskId }) -> void
//   - readTriggerTask({ runId, externalTaskId })  -> PmTaskState | null
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
//
// READ-BACK / FAIL-OPEN (cinatra#319, load-bearing): readTriggerTask is the
// inbound dual of the outbound upsert. It runs on the EXECUTION hot path so the
// host can honor a PM-side delete/pause/reschedule before firing. Plane CE has
// NO native pause or cron field on a work item, so the connector OWNS that state
// in the metadata IT writes on upsert (the description lines `cron:` /
// `scheduled:` / `(trigger disabled)`); readTriggerTask maps that metadata BACK
// to the provider-agnostic PmTaskState. CONTRACT: a clean 404 (the item was
// deleted upstream) is the ONLY signal returned as `null` (host tears down the
// schedule); EVERY other error/outage/timeout/malformed-read is RETHROWN so the
// host fail-opens (`unreachable` -> the schedule fires). Returning `null` on a
// transient blip would wrongly delete a live schedule, so non-404 paths never
// return null.

import type {
  PmConnector,
  PmTriggerTask,
  PmTaskRef,
} from "@cinatra-ai/sdk-extensions";

import { planeRest, PlaneRestError } from "./plane-rest-call";

const PROVIDER_ID = "plane";

// LANDING-ORDER NOTE (cinatra#319): `readTriggerTask` + its `PmTaskState` return
// type are added to the SDK `PmConnector` interface by cinatra#319 (PR #370).
// This connector is re-pinned into cinatra `main` BEFORE that interface change
// lands, so on `main` the SDK `PmConnector` does NOT yet declare
// `readTriggerTask` and does NOT export `PmTaskState`. To keep the SAME source
// typechecking GREEN on BOTH trees we (a) do NOT import `PmTaskState` by name
// (it's absent on main) and instead mirror its shape locally as
// `PmTaskStateLocal`, and (b) build the impl typed to a LOCAL
// `PlaneConnectorImpl extends PmConnector` interface and export it WIDENED to
// `PmConnector`. On main the extra `readTriggerTask` method widens cleanly via
// assignability (no excess-property-check, because the export is from a variable
// not a fresh literal); once #319 lands, `extends PmConnector` binds the local
// method to the SDK signature and structural typing matches `PmTaskStateLocal`
// to the SDK `PmTaskState` — so no further connector change is needed.
type PmTaskStateLocal = {
  externalTaskId: string;
  paused: boolean;
  cronExpression: string | null;
  scheduledAt: string | null;
};

/**
 * Local connector surface = the SDK `PmConnector` PLUS the `readTriggerTask`
 * read-back method (cinatra#319). Declaring it via `extends PmConnector` means
 * that once the SDK interface gains `readTriggerTask`, TypeScript binds this
 * method to the SDK signature and flags any drift; until then it is simply an
 * extra method the host that knows about #319 calls structurally.
 */
interface PlaneConnectorImpl extends PmConnector {
  readTriggerTask(input: {
    runId: string;
    externalTaskId: string;
  }): Promise<PmTaskStateLocal | null>;
}

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
// READ-BACK parsing: map a Plane work item's connector-owned metadata back to
// the provider-agnostic PmTaskState. The upsert stamps the cinatra schedule
// state into the work-item DESCRIPTION (Plane CE has no native pause/cron field
// on a work item), so the read mirror parses those same lines. Robust to Plane
// text normalization: lines may be separated by `\n`, `\r\n`, or flattened to
// spaces (description_stripped). Each extractor matches a `label:` token and the
// value up to the next known label or end; an empty/whitespace-only value
// normalizes to `null` (never an empty string — the host's structural guard
// wants string-or-null).
// ---------------------------------------------------------------------------

/** The disabled marker the upsert writes when `enabled === false`. */
const DISABLED_MARKER = "(trigger disabled)";

/** Known leading labels the description carries; used to bound a label's value
 *  so a flattened (space-joined) description doesn't swallow the next field. */
const META_LABELS = ["cinatra run", "trigger:", "cron:", "scheduled:", "tz:"];

/**
 * Extract the value following `label` from the work-item description, bounded by
 * the next known meta label, the disabled marker, or end-of-text. Returns the
 * trimmed value, or null when the label is absent or the value is empty. Works
 * whether the description kept its newlines or was flattened to a single line.
 */
function extractMeta(description: string, label: string): string | null {
  const idx = description.indexOf(label);
  if (idx === -1) return null;
  const after = description.slice(idx + label.length);
  // Find the earliest next-boundary: any OTHER known label, the disabled marker,
  // or a newline. Whatever comes first ends this value.
  let end = after.length;
  for (const other of [...META_LABELS, DISABLED_MARKER]) {
    if (other === label) continue;
    const at = after.indexOf(other);
    if (at !== -1 && at < end) end = at;
  }
  const nl = after.search(/[\r\n]/);
  if (nl !== -1 && nl < end) end = nl;
  const value = after.slice(0, end).trim();
  return value.length > 0 ? value : null;
}

/**
 * Map a fetched Plane work item to the provider-agnostic PmTaskState. The
 * connector OWNS pause/cron/scheduled state in the description it wrote on
 * upsert; here we read it back. `scheduledAt` prefers the EXACT instant the
 * upsert stamped (the `scheduled:` line) so a `scheduled` trigger does not
 * phantom-reschedule every tick (the host diffs the instant for scheduled
 * triggers); it falls back to deriving a midnight-UTC instant from `target_date`
 * (day granularity) only when no explicit instant was stamped.
 */
function toTaskState(item: PlaneWorkItem): PmTaskStateLocal {
  const desc = item.description_stripped ?? "";
  const paused = desc.includes(DISABLED_MARKER);
  const cronExpression = extractMeta(desc, "cron:");
  const stampedAt = extractMeta(desc, "scheduled:");
  const scheduledAt =
    stampedAt ?? (item.target_date ? `${item.target_date}T00:00:00.000Z` : null);
  return {
    externalTaskId: item.id,
    paused,
    cronExpression,
    scheduledAt,
  };
}

// ---------------------------------------------------------------------------
// Connector implementation
// ---------------------------------------------------------------------------
/**
 * The Plane connector implementation, typed to the LOCAL `PlaneConnectorImpl`
 * surface so `readTriggerTask` is statically visible to callers that know about
 * cinatra#319 (e.g. this package's tests) EVEN ON `main`, where the SDK
 * `PmConnector` does not yet declare it. The default export `planeConnector`
 * (widened to `PmConnector`) is what the registry consumes.
 */
export const planeConnectorImpl: PlaneConnectorImpl = {
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

  // -------------------------------------------------------------------------
  // READ-BACK (cinatra#319 pre-execution PM check). Inbound dual of the upsert:
  // GET the mirrored work item and map its connector-owned metadata to the
  // provider-agnostic PmTaskState.
  //
  // FAIL-OPEN CONTRACT (load-bearing): a clean 404 (the work item was deleted
  // upstream for this externalTaskId) is the ONLY path that returns `null` — the
  // host's definitive "deleted -> tear down the local schedule" signal. EVERY
  // other condition RETHROWS so the host maps it to `unreachable -> fail-open
  // proceed` (the schedule fires): a missing id (host invariant break), a network
  // outage (PlaneRestError status 0), an auth/authz error (401/403), a 5xx, a
  // parse failure, or a 200 with an empty/idless body. Returning `null` on any of
  // those would wrongly delete a LIVE schedule on a transient blip — forbidden.
  // -------------------------------------------------------------------------
  async readTriggerTask(input: {
    runId: string;
    externalTaskId: string;
  }): Promise<PmTaskStateLocal | null> {
    const { externalTaskId } = input;
    // An empty id is a host/connector invariant break, NOT a definitive upstream
    // delete. Throw so the host fail-opens (`unreachable`), never tears down.
    if (!externalTaskId) {
      throw new PlaneRestError(
        500,
        "readTriggerTask called with an empty externalTaskId (no upstream task to read)",
      );
    }

    let item: PlaneWorkItem | null;
    try {
      item = await planeRest<PlaneWorkItem>(
        "GET",
        `/work-items/${encodeURIComponent(externalTaskId)}/`,
      );
    } catch (err) {
      // ONLY a clean 404 = the task was DELETED upstream -> null (teardown).
      if (err instanceof PlaneRestError && err.status === 404) return null;
      // Anything else (network 0, 401/403 auth, 5xx, parse fail) -> rethrow so
      // the host fail-opens. NEVER swallow into a false delete.
      throw err;
    }

    // A 200 with no body / no id is NOT a definitive delete — fail-open by
    // throwing so the host treats it as unreachable, never as deleted.
    if (!item || !item.id) {
      throw new PlaneRestError(
        500,
        `Plane GET work-item returned no body/id for ${externalTaskId}`,
      );
    }

    return toTaskState(item);
  },
};

// Export WIDENED to the SDK `PmConnector`. On `main` (no `readTriggerTask` in the
// interface) this widening is a plain assignability check — the extra method is
// allowed because the source is a variable, not a fresh object literal (so no
// excess-property-check). Once cinatra#319 lands and the interface requires
// `readTriggerTask`, `PlaneConnectorImpl extends PmConnector` already guarantees
// the impl satisfies it (structural match on `PmTaskStateLocal` ≅ SDK
// `PmTaskState`), so this same line keeps compiling.
export const planeConnector: PmConnector = planeConnectorImpl;

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
