// Public surface for @cinatra-ai/plane-connector.

import { registerPmProvider } from "@cinatra-ai/sdk-extensions";
import { planeConnector } from "./plane-connector";

export { planeConnector } from "./plane-connector";
export { registerPlaneConnectorPrimitives } from "./mcp/module";
export type { PlaneInstanceConfig } from "./deps";

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
