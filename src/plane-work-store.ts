import "server-only";

// Plane implementation of the provider-agnostic PM WORK-ITEM STORE contract —
// the "PmConnector v2" typed CRUD surface (cinatra#1031, EPIC #1030). Sibling to
// plane-connector.ts (the trigger-mirror `PmConnector`); it reuses the SAME
// project-scoped REST helper (`planeRest`, X-API-Key, /workspaces/{slug}/
// projects/{projectId}/) and the SAME smoke-proven date contract, but exposes a
// full work-item CRUD store: create/read/update/close, list, comments, dates,
// assignees, dependency edges, and abstract status.
//
// This store is a project agent's PRIMARY task store, so — unlike the fail-open
// trigger mirror — it is FAIL-CLOSED: every mutation THROWS a `.code`-carrying
// error on failure (never a silent no-op) and is "landed" only after a READ-BACK
// confirms the provider persisted the MACHINE-CRITICAL fields (status, dates,
// dependsOn, assigneeIds, and the natural-key marker). The read-back generalizes
// the trigger mirror's `assertEchoedDate`.
//
// ── WHAT IS SMOKE-PROVEN vs PENDING LIVE SMOKE ─────────────────────────────
// SMOKE-PROVEN (Plane CE 1.3.1, on-the-wire; see plane-rest-call.ts): X-API-Key
// auth; /work-items/ CRUD under the project scope; start_date/target_date accept
// YYYY-MM-DD and due_date is SILENTLY DROPPED (never send it; assert the echo);
// the searchable title-marker natural-key pattern.
// LIVE-SMOKE-PROVEN (real Plane CE round-trip — the fixes below): (1) the rich
// text description round-trips ONLY via `description_html` — a plain `description`
// sent on write is dropped, and on read Plane returns NEITHER `description_stripped`
// NOR `description`, only `description_html`; so the authoritative status/deps
// block rides in `description_html` and is recovered by stripping it back to text.
// (2) list pagination terminates on the explicit `next_page_results:false`, NOT on
// a falsy cursor — Plane returns a TRUTHY `next_cursor` on the terminal page, so
// keying only off cursor truthiness over-paginates to the page cap / rate limit.
// PENDING LIVE SMOKE (coded to the documented Plane CE REST shape, MOCK-tested to
// pin that shape, and GUARDED by read-after-write so a wrong shape fails LOUDLY,
// never silently): the work-item `assignees` array, the `/comments/` endpoint
// field names, and `updated_at` presence. These MUST be verified against a live
// Plane CE before W2/W3 depend on them in production.
//
// ── AUTHORITATIVE STATE lives in SMOKE-SAFE channels ───────────────────────
// To keep the contract's correctness guarantees independent of the un-proven
// endpoints, the item's machine-authoritative fields round-trip through
// smoke-safe channels ONLY:
//   - naturalKey  -> a searchable TITLE marker  [cinatra-work:<naturalKey>]
//                    (a DISTINCT namespace from the trigger mirror's
//                    [cinatra:<runId>], so work-store items and trigger items are
//                    never the same Plane item — no metadata collision).
//   - dates       -> native start_date/target_date (smoke-proven + asserted).
//   - status+deps -> a FENCED, namespaced connector-owned metadata block carried
//                    in `description_html` ([cinatra-work-store] … [/cinatra-work-store]),
//                    parsed back deterministically (HTML stripped to text) and
//                    asserted. (Abstract
//                    `status` is authoritative here; a native Plane board-state
//                    projection is a W3 enhancement, once the /states/ endpoint is
//                    smoke-proven — deferred so W1 correctness needs no /states/.)
//   - assignees   -> native Plane `assignees` (PENDING LIVE SMOKE; asserted).
// The title + body are free-text the caller may not fill with the connector's
// reserved tokens (rejected up front); a provider may normalize rich text, so
// title/body are NOT read-after-write asserted. `version` derives from
// `updated_at` when present, else a stable content hash — a best-effort,
// NON-ATOMIC conflict detector (Plane REST has no If-Match), never a claim
// primitive (W2's project LEASE + dispatch LEDGER are the real lock; this store
// is single-writer per project per tick under that lease).

import { planeRest, PlaneRestError, PlaneConfigError } from "./plane-rest-call";

const PROVIDER_ID = "plane";

// ── LOCAL MIRROR of the SDK PmWorkStore contract ───────────────────────────
// The SDK `@cinatra-ai/sdk-extensions` this connector compiles against (as a
// source mirror, the monorepo typechecks it against the CURRENTLY-pinned SDK)
// does NOT yet export the PmWorkStore types (they land in cinatra#1031's SDK PR).
// So — exactly like the readTriggerTask landing note in plane-connector.ts — we
// mirror the shapes LOCALLY and implement to a local interface, keeping the SAME
// source green on BOTH trees. Once the SDK contract lands + the pin bumps (W2), a
// trivial follow-up can bind this to the SDK `PmWorkStore` via `satisfies`.
export type PmWorkItemStatusLocal =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

export type PmWorkItemLocal = {
  id: string;
  naturalKey: string;
  title: string;
  body?: string | null;
  status: PmWorkItemStatusLocal;
  startDate?: string | null;
  dueDate?: string | null;
  assigneeIds?: string[];
  dependsOn?: string[];
  version: string;
};

export type PmWorkItemDraftLocal = Omit<PmWorkItemLocal, "id" | "version">;
export type PmWorkItemPatchLocal = Partial<
  Omit<PmWorkItemLocal, "id" | "naturalKey" | "version">
>;
export type PmWorkItemCommentLocal = {
  id: string;
  body: string;
  createdAt: string;
};

type PmWorkStoreErrorCodeLocal =
  | "validation"
  | "conflict"
  | "write_verification"
  | "not_found"
  | "config"
  | "transport";

interface PlaneWorkStoreImpl {
  providerId: string;
  createWorkItem(input: { item: PmWorkItemDraftLocal }): Promise<PmWorkItemLocal>;
  getWorkItemByKey(input: { naturalKey: string }): Promise<PmWorkItemLocal | null>;
  getWorkItem(input: { id: string }): Promise<PmWorkItemLocal | null>;
  listWorkItems(): Promise<PmWorkItemLocal[]>;
  updateWorkItem(input: {
    id: string;
    patch: PmWorkItemPatchLocal;
    expectedVersion?: string;
  }): Promise<PmWorkItemLocal>;
  closeWorkItem(input: {
    id: string;
    status?: "done" | "cancelled";
    expectedVersion?: string;
  }): Promise<PmWorkItemLocal>;
  addComment(input: { id: string; body: string }): Promise<PmWorkItemCommentLocal>;
  listComments(input: { id: string }): Promise<PmWorkItemCommentLocal[]>;
}

/**
 * Error the store throws, carrying the structural `.code` discriminant the SDK
 * contract specifies (a consumer classifies by `.code`, not `instanceof`). EVERY
 * error out of this store is a PlaneWorkStoreError — a `PlaneRestError` (404 ->
 * not_found, else transport), a `PlaneConfigError` (-> config), and any other
 * throwable (-> transport) are all wrapped so the `.code` contract holds.
 */
export class PlaneWorkStoreError extends Error {
  readonly code: PmWorkStoreErrorCodeLocal;
  readonly cause?: unknown;
  constructor(code: PmWorkStoreErrorCodeLocal, message: string, cause?: unknown) {
    super(message);
    this.name = "PlaneWorkStoreError";
    this.code = code;
    this.cause = cause;
  }
}

// ── Raw Plane work-item shape (subset this store reads) ─────────────────────
type PlaneWorkItem = {
  id: string;
  name?: string;
  description_stripped?: string | null;
  description?: string | null;
  description_html?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  assignees?: string[] | null;
  updated_at?: string | null;
};

// LIVE-SMOKE-PROVEN (real Plane CE round-trip): Plane CE public API v1 persists
// the rich-text `description_html` and returns NEITHER `description_stripped` NOR
// `description` on read; a plain `description` sent on write is dropped. So the
// connector's authoritative status/deps metadata block must ride in
// `description_html` and be recovered by stripping that HTML back to plain text
// (its sentinels are plain text inside <p>/<div>, so tag-stripping recovers them).
// Deterministic + total.
function stripHtmlToText(html: string | null | undefined): string {
  if (!html) return "";
  // Block-level tags -> a newline (so paragraph structure survives the strip).
  let text = html.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, "\n");
  // Remove every remaining tag, repeating to a FIXPOINT. A single pass can be
  // defeated by a nested/overlapping fragment (e.g. "<a<b>>") that re-forms a
  // "<...>" after one removal; looping until the string stops changing removes
  // them completely. (This is the standard remediation for incomplete
  // multi-character sanitization; here the result is only parsed for the
  // connector's plain-text metadata tokens and is never re-emitted as HTML.)
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  }
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Decode &amp; LAST — it is the exact inverse of textToHtml, which escapes `&`
    // first. Decoding it FIRST would double-decode literal user text: a body that
    // literally contains "&lt;" is escaped on write to "&amp;lt;", and an
    // amp-first pass would turn it back into "<". Amp-last makes textToHtml ->
    // stripHtmlToText a faithful round-trip for `&`, `<`, `>` AND for entity-like
    // literal text a caller may have typed.
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** Recover the connector's plain-text description. Prefer a NON-EMPTY
 *  provider-plain field (some Plane builds still emit `description_stripped` /
 *  `description`), else strip the rich-text `description_html` (real Plane CE
 *  returns ONLY that). The plain field must be non-EMPTY, not merely non-null: an
 *  empty-string `description_stripped`/`description` must NOT mask a populated
 *  `description_html` (that would drop the authoritative status/deps block). */
function readDescription(raw: PlaneWorkItem): string {
  const plain = [raw.description_stripped, raw.description].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return plain ?? stripHtmlToText(raw.description_html);
}
/** Wrap the connector's plain-text description as HTML Plane will persist AND
 *  strip back cleanly: one <p> per SOURCE line, blank lines kept as empty
 *  paragraphs (so the human body's paragraph breaks survive) and line content NOT
 *  trimmed (so indentation survives). The fenced metadata block's own lines are
 *  already whitespace-clean and non-empty, so their on-the-wire HTML is IDENTICAL
 *  either way — only the human body gains fidelity, and the live-proven block
 *  round-trip is unchanged. */
function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const escaped = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return escaped.length > 0 ? `<p>${escaped}</p>` : "<p></p>";
    })
    .join("");
}

type PlaneListResponse =
  | { results?: PlaneWorkItem[]; next_cursor?: string | null; next?: string | null; next_page_results?: boolean }
  | PlaneWorkItem[];

type PlaneComment = {
  id: string;
  comment_stripped?: string | null;
  comment_html?: string | null;
  created_at?: string | null;
};
type PlaneCommentListResponse = { results?: PlaneComment[] } | PlaneComment[];

// ── Marker + metadata helpers (smoke-safe authoritative channels) ──────────

/** The work-store natural-key marker namespace prefix (DISTINCT from the trigger
 *  mirror's `[cinatra:` so the two seams never address the same Plane item). */
const MARKER_PREFIX = "[cinatra-work:";
/** Fenced, namespaced metadata block sentinels (survive Plane's
 *  description_stripped normalization — plain-text brackets, not markup). */
const META_OPEN = "[cinatra-work-store]";
const META_CLOSE = "[/cinatra-work-store]";
/** Tokens the connector reserves for its own marker/metadata channels; a
 *  caller's title/body may not contain any of them (else they could inject or
 *  corrupt the authoritative metadata parse). Rejected before any write. */
const RESERVED_TOKENS = [MARKER_PREFIX, META_OPEN, META_CLOSE];

function markerFor(naturalKey: string): string {
  return `${MARKER_PREFIX}${naturalKey}]`;
}

function composeTitle(title: string, naturalKey: string): string {
  return `${title} ${markerFor(naturalKey)}`.trim();
}

/** Strip a trailing work-store marker off a Plane title to recover the human title. */
function stripTitleMarker(name: string, naturalKey: string): string {
  const marker = markerFor(naturalKey);
  const idx = name.lastIndexOf(marker);
  if (idx === -1) return name.trim();
  return name.slice(0, idx).trim();
}

/** Reject caller input (title/body) that contains a connector-reserved token —
 *  otherwise a body carrying `[cinatra-work-store]` could be parsed as
 *  authoritative metadata, or corrupt the body strip. Fail-closed, pre-write. */
function assertNoReservedTokens(draft: PmWorkItemDraftLocal): void {
  const fields: Array<[string, string]> = [
    ["title", draft.title ?? ""],
    ["body", draft.body ?? ""],
  ];
  for (const [field, value] of fields) {
    for (const tok of RESERVED_TOKENS) {
      if (value.includes(tok)) {
        throw new PlaneWorkStoreError(
          "validation",
          `${field} may not contain the connector-reserved token "${tok}"`,
        );
      }
    }
  }
}

/** Serialize the authoritative status + deps into the fenced metadata block. */
function composeMetaBlock(status: PmWorkItemStatusLocal, dependsOn: string[]): string {
  // deps joined by `|` (a char that cannot appear in a natural key token) so a
  // flattened description does not merge/split the list on spaces or commas.
  return `${META_OPEN}\nstatus: ${status}\ndeps: ${dependsOn.join("|")}\n${META_CLOSE}`;
}

/** Compose the full description = human body + the fenced metadata block. */
function composeDescription(
  body: string | null | undefined,
  status: PmWorkItemStatusLocal,
  dependsOn: string[],
): string {
  const human = (body ?? "").trim();
  const block = composeMetaBlock(status, dependsOn);
  return human ? `${human}\n\n${block}` : block;
}

/** Extract the LAST fenced metadata block's inner text (the connector always
 *  appends its block, so the last occurrence is authoritative even if — despite
 *  the reserved-token guard — a sentinel ever appeared earlier); null when
 *  absent. */
function extractMetaBlockText(description: string): string | null {
  const open = description.lastIndexOf(META_OPEN);
  if (open === -1) return null;
  const afterOpen = open + META_OPEN.length;
  const close = description.indexOf(META_CLOSE, afterOpen);
  return description.slice(afterOpen, close === -1 ? description.length : close);
}

/** Parse the authoritative status from the metadata block, or null if absent/bad. */
function parseMetaStatus(blockText: string): PmWorkItemStatusLocal | null {
  const m = /status:\s*([a-z_]+)/i.exec(blockText);
  const raw = m?.[1]?.toLowerCase();
  const known: PmWorkItemStatusLocal[] = [
    "backlog",
    "todo",
    "in_progress",
    "blocked",
    "done",
    "cancelled",
  ];
  return known.includes(raw as PmWorkItemStatusLocal)
    ? (raw as PmWorkItemStatusLocal)
    : null;
}

/** Parse the deps list from the metadata block (bounded by the `deps:` label to
 *  the next known label or the block end); [] when absent/empty. */
function parseMetaDeps(blockText: string): string[] {
  const idx = blockText.indexOf("deps:");
  if (idx === -1) return [];
  const after = blockText.slice(idx + "deps:".length);
  // Bound the value: stop at the next known label (`status:`) if it trails deps.
  const stop = after.indexOf("status:");
  const value = (stop === -1 ? after : after.slice(0, stop)).trim();
  if (!value) return [];
  return value
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Recover the human body = description with the LAST fenced metadata block
 *  removed. */
function stripMetaBlock(description: string): string {
  const open = description.lastIndexOf(META_OPEN);
  if (open === -1) return description.trim();
  const close = description.indexOf(META_CLOSE, open);
  const before = description.slice(0, open);
  const after = close === -1 ? "" : description.slice(close + META_CLOSE.length);
  return `${before}${after}`.trim();
}

// ── Date safety (reused from the trigger mirror's smoke-proven contract) ────
function toCalendarDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new PlaneWorkStoreError(
      "validation",
      `invalid calendar date: ${value} (expected YYYY-MM-DD)`,
    );
  }
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) {
    throw new PlaneWorkStoreError("validation", `invalid calendar date: ${value}`);
  }
  return day;
}

// ── Version (best-effort, NON-ATOMIC conflict detector) ─────────────────────
/** A tiny stable hash (djb2) over the authoritative content, used only when
 *  Plane returns no `updated_at`. Never a claim primitive. */
function contentHash(item: PmWorkItemLocal): string {
  const canonical = JSON.stringify({
    s: item.status,
    sd: item.startDate ?? null,
    dd: item.dueDate ?? null,
    dep: [...(item.dependsOn ?? [])].sort(),
    as: [...(item.assigneeIds ?? [])].sort(),
    t: item.title,
    b: item.body ?? null,
  });
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) h = ((h << 5) + h + canonical.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

/** Recover the natural key from a Plane work-item title marker, or null. */
function naturalKeyFromName(name: string | undefined): string | null {
  if (!name) return null;
  const start = name.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const afterPrefix = start + MARKER_PREFIX.length;
  const end = name.indexOf("]", afterPrefix);
  if (end === -1) return null;
  const key = name.slice(afterPrefix, end);
  return key.length > 0 ? key : null;
}

// ── Map a raw Plane work item -> the provider-agnostic PmWorkItem ───────────
// The natural key is DERIVED from the item's own title marker (never trusted
// from the caller) so a dropped/altered marker is caught by read-after-write.
function toWorkItem(raw: PlaneWorkItem): PmWorkItemLocal {
  const naturalKey = naturalKeyFromName(raw.name) ?? "";
  const desc = readDescription(raw);
  const blockText = extractMetaBlockText(desc);
  const status = (blockText && parseMetaStatus(blockText)) || "backlog";
  const dependsOn = blockText ? parseMetaDeps(blockText) : [];
  const item: PmWorkItemLocal = {
    id: raw.id,
    naturalKey,
    title: raw.name ? stripTitleMarker(raw.name, naturalKey) : "",
    body: stripMetaBlock(desc) || null,
    status,
    startDate: raw.start_date ?? null,
    dueDate: raw.target_date ?? null,
    assigneeIds: Array.isArray(raw.assignees) ? raw.assignees : [],
    dependsOn,
    version: "",
  };
  item.version =
    typeof raw.updated_at === "string" && raw.updated_at.length > 0
      ? raw.updated_at
      : contentHash(item);
  return item;
}

// ── Wire body builder ────────────────────────────────────────────────────────
/** The write body for CREATE + PATCH. On PATCH (`clearNulls`) a null date is
 *  sent EXPLICITLY as null so a date CLEAR is applied (and read-after-write can
 *  verify it landed); on CREATE a null date is omitted (nothing to clear). */
function workItemWriteBody(
  desired: PmWorkItemDraftLocal,
  calStart: string | null,
  calDue: string | null,
  opts: { clearNulls: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: composeTitle(desired.title, desired.naturalKey),
    // LIVE-SMOKE-PROVEN: write the rich-text field Plane CE actually persists.
    description_html: textToHtml(
      composeDescription(desired.body, desired.status, desired.dependsOn ?? []),
    ),
  };
  if (calStart !== null) body.start_date = calStart;
  else if (opts.clearNulls) body.start_date = null;
  // NEVER due_date — only target_date (smoke-proven the due_date field is dropped).
  if (calDue !== null) body.target_date = calDue;
  else if (opts.clearNulls) body.target_date = null;
  if (desired.assigneeIds !== undefined) body.assignees = desired.assigneeIds;
  return body;
}

// ── REST wrapper: EVERY error out carries a `.code` (the contract) ──────────
async function rest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await planeRest<T>(method, path, body);
  } catch (err) {
    if (err instanceof PlaneWorkStoreError) throw err;
    if (err instanceof PlaneRestError) {
      const code = err.status === 404 ? "not_found" : "transport";
      throw new PlaneWorkStoreError(code, `Plane ${method} ${path} failed: ${err.message}`, err);
    }
    if (err instanceof PlaneConfigError) {
      throw new PlaneWorkStoreError("config", `Plane not configured: ${err.message}`, err);
    }
    throw new PlaneWorkStoreError(
      "transport",
      `Plane ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

async function getRawById(id: string): Promise<PlaneWorkItem | null> {
  try {
    return await rest<PlaneWorkItem>("GET", `/work-items/${encodeURIComponent(id)}/`);
  } catch (err) {
    if (err instanceof PlaneWorkStoreError && err.code === "not_found") return null;
    throw err;
  }
}

// ── Pagination-exhausting list by marker substring (fail-closed) ────────────
// Follows `next_cursor` (or a `cursor` param off a `next` URL); detects a cursor
// loop and throws; throws if it exceeds a hard page cap rather than silently
// truncating (a truncated scan would silently drop items from the W2 ready
// predicate — the exact silent failure this store must never do). A failed page
// fetch propagates (STRICT — never treated as "no more items").
const MAX_LIST_PAGES = 1000;
function cursorFromNextUrl(next: string | null | undefined): string | null {
  if (!next) return null;
  try {
    return new URL(next, "http://placeholder.invalid").searchParams.get("cursor");
  } catch {
    return null;
  }
}
async function listAllByMarker(markerSubstring: string): Promise<PlaneWorkItem[]> {
  const out: PlaneWorkItem[] = [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_LIST_PAGES) {
      throw new PlaneWorkStoreError(
        "transport",
        `Plane work-item list did not terminate within ${MAX_LIST_PAGES} pages`,
      );
    }
    const q = `/work-items/?search=${encodeURIComponent(markerSubstring)}&per_page=100${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const list = await rest<PlaneListResponse>("GET", q);
    const rows = Array.isArray(list) ? list : (list?.results ?? []);
    for (const w of rows) {
      if (w.id && !seen.has(w.id) && (w.name ?? "").includes(markerSubstring)) {
        seen.add(w.id);
        out.push(w);
      }
    }
    // LIVE-SMOKE-PROVEN fix: Plane CE returns a TRUTHY next_cursor even on the
    // terminal/empty page (e.g. "100:1:0" with 0 results); its explicit
    // next_page_results:false is the real terminator. Keying only off next_cursor
    // truthiness over-paginates to the page cap / rate limit on every marker find.
    if (!Array.isArray(list) && list?.next_page_results === false) break;
    const next = Array.isArray(list)
      ? null
      : (list?.next_cursor ?? cursorFromNextUrl(list?.next) ?? null);
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new PlaneWorkStoreError("transport", "Plane work-item list cursor loop detected");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return out;
}

// ── STRICT natural-key find (paginated; a lookup FAILURE propagates) ────────
async function findRawByKey(naturalKey: string): Promise<PlaneWorkItem | null> {
  const marker = markerFor(naturalKey);
  const matches = await listAllByMarker(marker);
  if (matches.length === 0) return null;
  // Deterministic survivor: smallest id, so every operation for this key
  // converges on ONE item even if a duplicate ever slipped past the W2 lease.
  return matches.reduce((min, w) => (w.id < min.id ? w : min));
}

// ── read-after-write assertion (the MACHINE-CRITICAL fields, exact) ─────────
function assertLanded(sent: PmWorkItemDraftLocal, landed: PmWorkItemLocal): void {
  const problems: string[] = [];
  // naturalKey is DERIVED from the landed title marker — a dropped/altered
  // marker fails here (the readback maps the key from the item itself).
  if (landed.naturalKey !== sent.naturalKey)
    problems.push(`naturalKey sent "${sent.naturalKey}" landed "${landed.naturalKey}"`);
  if (landed.status !== sent.status)
    problems.push(`status sent "${sent.status}" landed "${landed.status}"`);
  // Dates asserted EXACTLY (null-aware) so a CLEAR that no-ops upstream fails.
  const sentStart = toCalendarDate(sent.startDate ?? null);
  if ((landed.startDate ?? null) !== sentStart)
    problems.push(`startDate sent "${sentStart}" landed "${landed.startDate ?? null}"`);
  const sentDue = toCalendarDate(sent.dueDate ?? null);
  if ((landed.dueDate ?? null) !== sentDue)
    problems.push(`dueDate sent "${sentDue}" landed "${landed.dueDate ?? null}"`);
  if (!sameSet(sent.dependsOn ?? [], landed.dependsOn ?? []))
    problems.push(`dependsOn sent [${(sent.dependsOn ?? []).join(",")}] landed [${(landed.dependsOn ?? []).join(",")}]`);
  if (sent.assigneeIds !== undefined && !sameSet(sent.assigneeIds, landed.assigneeIds ?? []))
    problems.push(`assigneeIds sent [${sent.assigneeIds.join(",")}] landed [${(landed.assigneeIds ?? []).join(",")}]`);
  if (problems.length > 0) {
    throw new PlaneWorkStoreError(
      "write_verification",
      `Plane did not persist the write as sent (refusing to report success on lost data): ${problems.join("; ")}`,
    );
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Merge a patch onto a base item to produce the FULL desired draft (so a PATCH
 *  rewrites the whole metadata block + fields deterministically, and read-back
 *  can assert the full desired state). */
function applyPatch(base: PmWorkItemLocal, patch: PmWorkItemPatchLocal): PmWorkItemDraftLocal {
  return {
    naturalKey: base.naturalKey,
    title: patch.title ?? base.title,
    body: patch.body !== undefined ? patch.body : (base.body ?? null),
    status: patch.status ?? base.status,
    startDate: patch.startDate !== undefined ? patch.startDate : (base.startDate ?? null),
    dueDate: patch.dueDate !== undefined ? patch.dueDate : (base.dueDate ?? null),
    assigneeIds: patch.assigneeIds !== undefined ? patch.assigneeIds : (base.assigneeIds ?? []),
    dependsOn: patch.dependsOn !== undefined ? patch.dependsOn : (base.dependsOn ?? []),
  };
}

/** Assert the connector-owned fenced metadata block PHYSICALLY survived the write
 *  with a real `status:` and a real `deps:` field. This closes a silent-success
 *  hole: `toWorkItem` maps an ABSENT/malformed block to the DEFAULTS (status
 *  "backlog", deps []), so a write of exactly `status:"backlog"` + empty deps that
 *  LOST the entire `[cinatra-work-store]` block (Plane dropped/normalized the
 *  description) would otherwise map back to those same defaults and pass
 *  `assertLanded` — reporting success on lost authoritative state. Every write
 *  path emits the block (`composeDescription` always appends it), so on read-back
 *  the block MUST be present and well-formed; its absence is real data loss. */
function assertMetaBlockPersisted(rawDescription: string, naturalKey: string): void {
  const blockText = extractMetaBlockText(rawDescription);
  if (blockText === null) {
    throw new PlaneWorkStoreError(
      "write_verification",
      `Plane did not persist the [cinatra-work-store] metadata block for "${naturalKey}" (the authoritative status/deps block was lost from the description)`,
    );
  }
  if (parseMetaStatus(blockText) === null) {
    throw new PlaneWorkStoreError(
      "write_verification",
      `Plane persisted a [cinatra-work-store] block for "${naturalKey}" without a valid status: field`,
    );
  }
  // `composeMetaBlock` always emits a literal `deps:` label (empty or not); its
  // absence means the block was mangled, so an empty `dependsOn` must not be
  // conflated with a lost deps field.
  if (!/deps:/i.test(blockText)) {
    throw new PlaneWorkStoreError(
      "write_verification",
      `Plane persisted a [cinatra-work-store] block for "${naturalKey}" without a deps: field`,
    );
  }
}

/** TRUE read-after-write: a SEPARATE GET of the persisted row (never the write
 *  echo — Plane can 2xx with a field silently dropped, the due_date trap) mapped
 *  with the natural key DERIVED from the landed item, then asserted. */
async function readBackAndAssert(id: string, desired: PmWorkItemDraftLocal): Promise<PmWorkItemLocal> {
  const raw = await getRawById(id);
  if (!raw) {
    throw new PlaneWorkStoreError(
      "write_verification",
      `Plane write of ${desired.naturalKey} reported success but the item could not be read back`,
    );
  }
  // Assert the authoritative metadata block physically survived BEFORE trusting
  // the (default-filling) map — otherwise a total block loss on a backlog/empty
  // -deps write would pass as a no-op-equal read-back.
  assertMetaBlockPersisted(readDescription(raw), desired.naturalKey);
  const landed = toWorkItem(raw);
  assertLanded(desired, landed);
  return landed;
}

/** PATCH a work item to the FULL desired draft, then read-back + assert. */
async function patchToDraft(id: string, desired: PmWorkItemDraftLocal): Promise<PmWorkItemLocal> {
  assertNoReservedTokens(desired);
  const calStart = toCalendarDate(desired.startDate ?? null);
  const calDue = toCalendarDate(desired.dueDate ?? null);
  await rest<PlaneWorkItem>(
    "PATCH",
    `/work-items/${encodeURIComponent(id)}/`,
    workItemWriteBody(desired, calStart, calDue, { clearNulls: true }),
  );
  return readBackAndAssert(id, desired);
}

// ═══════════════════════════════════════════════════════════════════════════
// The Plane work-store implementation
// ═══════════════════════════════════════════════════════════════════════════
export const planeWorkStore: PlaneWorkStoreImpl = {
  providerId: PROVIDER_ID,

  async createWorkItem(input): Promise<PmWorkItemLocal> {
    const draft = input.item;
    // Validate caller input BEFORE any wire call — fail fast, no wasted round-trip.
    assertNoReservedTokens(draft);
    const calStart = toCalendarDate(draft.startDate ?? null);
    const calDue = toCalendarDate(draft.dueDate ?? null);
    // NATURAL-KEY find-or-create (idempotent — a re-run converges on the SAME
    // item): a STRICT, PAGINATED lookup by marker FIRST (a failed lookup throws,
    // never a blind create). This store is single-writer per project per tick
    // under W2's lease, so there is no lock-free reconcile — the strict find is
    // the connector-level idempotency, the lease is the concurrency control.
    const existing = await findRawByKey(draft.naturalKey);
    if (existing) {
      return patchToDraft(existing.id, draft);
    }
    const created = await rest<PlaneWorkItem>(
      "POST",
      `/work-items/`,
      workItemWriteBody(draft, calStart, calDue, { clearNulls: false }),
    );
    if (!created || !created.id) {
      throw new PlaneWorkStoreError("write_verification", "Plane CREATE work-item returned no id");
    }
    return readBackAndAssert(created.id, draft);
  },

  async getWorkItemByKey(input): Promise<PmWorkItemLocal | null> {
    const raw = await findRawByKey(input.naturalKey);
    return raw ? toWorkItem(raw) : null;
  },

  async getWorkItem(input): Promise<PmWorkItemLocal | null> {
    const raw = await getRawById(input.id);
    return raw ? toWorkItem(raw) : null;
  },

  async listWorkItems(): Promise<PmWorkItemLocal[]> {
    // EVERY cinatra-managed item in the project scope — exhausting pagination
    // (fail-closed) — mapped, dropping any that lost their marker.
    const rows = await listAllByMarker(MARKER_PREFIX);
    const out: PmWorkItemLocal[] = [];
    for (const raw of rows) {
      const item = toWorkItem(raw);
      if (item.naturalKey) out.push(item);
    }
    return out;
  },

  async updateWorkItem(input): Promise<PmWorkItemLocal> {
    const current = await getRawById(input.id);
    if (!current) {
      throw new PlaneWorkStoreError("not_found", `work item ${input.id} does not exist`);
    }
    const currentItem = toWorkItem(current);
    // Best-effort optimistic concurrency: a stale expectedVersion means a
    // concurrent write landed first — refuse (NON-ATOMIC; a TOCTOU window remains
    // before the PATCH, so W2's lease/ledger is the real lock).
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentItem.version) {
      throw new PlaneWorkStoreError(
        "conflict",
        `version conflict for work item ${input.id}: expected "${input.expectedVersion}", live "${currentItem.version}"`,
      );
    }
    const desired = applyPatch(currentItem, input.patch);
    return patchToDraft(input.id, desired);
  },

  async closeWorkItem(input): Promise<PmWorkItemLocal> {
    return this.updateWorkItem({
      id: input.id,
      patch: { status: input.status ?? "done" },
      expectedVersion: input.expectedVersion,
    });
  },

  async addComment(input): Promise<PmWorkItemCommentLocal> {
    // PENDING LIVE SMOKE: Plane CE comment create field is `comment_html`
    // (rich-text); the plain-text mirror is the read-only `comment_stripped`.
    const created = await rest<PlaneComment>(
      "POST",
      `/work-items/${encodeURIComponent(input.id)}/comments/`,
      { comment_html: input.body },
    );
    if (!created || !created.id) {
      throw new PlaneWorkStoreError("write_verification", "Plane CREATE comment returned no id");
    }
    // read-after-write: confirm the comment is present upstream (fail-closed).
    const back = await this.listComments({ id: input.id });
    const landed = back.find((c) => c.id === created.id);
    if (!landed) {
      throw new PlaneWorkStoreError(
        "write_verification",
        `Plane comment ${created.id} was not readable back after create`,
      );
    }
    return landed;
  },

  async listComments(input): Promise<PmWorkItemCommentLocal[]> {
    const list = await rest<PlaneCommentListResponse>(
      "GET",
      `/work-items/${encodeURIComponent(input.id)}/comments/`,
    );
    const rows = Array.isArray(list) ? list : (list?.results ?? []);
    return rows
      .filter((c) => c.id)
      .map((c) => ({
        id: c.id,
        body: (c.comment_stripped ?? c.comment_html ?? "").trim(),
        createdAt: c.created_at ?? "",
      }));
  },
};
