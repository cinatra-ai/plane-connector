// Public surface for @cinatra-ai/plane-connector.

import { registerPmProvider } from "@cinatra-ai/sdk-extensions";
import { planeConnector } from "./plane-connector";

export { planeConnector } from "./plane-connector";
// The "PmConnector v2" work-item CRUD store (cinatra#1031). Registered behind the
// `pm-work-store` capability from ./register; exported here for tests + a future
// direct-registration path once the SDK work-store registry ships (it is NOT
// value-wired to the SDK yet — the connector stays green against the current SDK
// via the local-mirror pattern in ./plane-work-store).
export { planeWorkStore } from "./plane-work-store";
export { registerPlaneConnectorPrimitives } from "./mcp/module";
export type { PlaneInstanceConfig } from "./deps";
// Headless prod auto-connect (#40): the in-connector replacement for the ops
// first-run mint. `runPlaneAutoConnect` is the env-driven prod entry; the rest
// are exported for tests + a direct-invocation path.
export {
  ensurePlaneTokenAttached,
  runPlaneAutoConnect,
  mintPlaneToken,
  validatePlaneToken,
  probePlaneVersion,
  fingerprint,
  SUPPORTED_PLANE_VERSIONS,
  PlaneMintError,
  type PlaneProvisionDeps,
  type PlaneAutoConnectOptions,
  type PlaneAutoConnectResult,
  type PlaneAutoConnectStatus,
  type PlaneValidation,
} from "./plane-provision";

/**
 * Boot-time entry point. Registers the Plane provider with the SDK PM provider
 * registry so `lookupPmProvider("plane")` resolves. Idempotent.
 *
 * (In production the connector self-registers behind the `pm-provider`
 * capability from its `serverEntry` (./register); this helper is the direct
 * registration path used by tests + non-capability boots.)
 */
export function registerPlaneProvider(): void {
  registerPmProvider(planeConnector);
}
