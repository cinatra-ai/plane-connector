// Thin server-component entry for the plane-connector setup page.
// Host mounts this at `/connectors/cinatra-ai/plane-connector/setup` via
// `src/lib/connector-setup-pages.ts`.

import { PlaneConnectorSetupImpl } from "./plane-setup-impl";

export default async function PlaneConnectorSetupPage() {
  return <PlaneConnectorSetupImpl />;
}
