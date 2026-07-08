// The plane connector's `register(ctx)` server entry.
//
// This entry registers the Plane `PmConnector` impl behind the `pm-provider`
// capability at activation. The host's PM bridge
// (src/lib/register-pm-providers.ts) feeds the SDK provider registry's external
// resolver from this capability, so `lookupPmProvider("plane")` resolves without
// the host naming this package. The host's trigger lifecycle mirrors run
// triggers into this connector via src/lib/pm-integration-providers.ts.
//
// This entry ALSO binds the connector's host deps slot (`./deps`) by adapting
// the per-concern host services published in the capability registry
// (`@cinatra-ai/host:secrets-codec` for PAT encryption + the connector's own
// config store). Every adapter member resolves its host service LAZILY at call
// time, so activation order against the host's boot imports never matters.
// Registration-only (no I/O) — probe-safe.
//
// SDK imports here are TYPE-ONLY (host-peer value-import gate): the provider
// impl and the host services both travel as DATA through `ctx.capabilities`;
// the capability id is an inlined string literal; the service shape is a local
// structural type so the connector compiles against ANY host SDK it can meet
// during skew. Mirrors twenty-connector/src/register.ts.

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { planeConnector } from "./plane-connector";
import { planeWorkStore } from "./plane-work-store";
import {
  registerPlaneConnector,
  type PlaneConnectorHostDeps,
  type PlaneInstanceConfig,
  type PlaneSecretsCodec,
} from "./deps";

const PACKAGE_NAME = "@cinatra-ai/plane-connector";

// Connector-config row key (namespaced under this package so the generic host
// connector-config store never collides with another connector's rows).
//
// NOTE (merged PmConnector contract, #366): the HOST owns the
// runId<->externalTaskId link table (pm-link) — the connector keeps NO
// runId→taskId mapping rows. Only the single instance-config row is stored here.
const INSTANCE_CONFIG_KEY = `${PACKAGE_NAME}:instance`;

// Local STRUCTURAL shape of the host secrets-codec service this connector
// adapts into its deps slot.
type HostSecretsCodecShape = PlaneSecretsCodec;

// Local STRUCTURAL shape of the EXISTING generic host connector-config store
// (capability id `@cinatra-ai/host:connector-config`, published by
// register-host-connector-services). The connector builds its typed
// instance-config surface on top of these generic read/write members — no
// bespoke host capability is required.
type HostConnectorConfigShape = {
  read<T>(connectorId: string, fallback: T): T;
  write(connectorId: string, value: unknown): void;
  delete(connectorId: string): void;
};

/** Lazy per-concern host-service resolution (fail-loud on a missing service —
 *  the host boot wiring publishes it before any connector call runs). */
function hostService<T>(ctx: ExtensionHostContext, capability: string): T {
  const provider = ctx.capabilities.resolveProviders(capability)[0];
  if (!provider) {
    throw new Error(
      `${PACKAGE_NAME}: host service "${capability}" is not registered — ` +
        `the host boot wiring must run before connector calls.`,
    );
  }
  return provider.impl as T;
}

/** Build the host-bound deps from the per-concern host services. Every member
 *  resolves LAZILY at call time — constructing this object does no I/O and no
 *  resolution (probe-safe). */
function buildHostBoundDeps(ctx: ExtensionHostContext): PlaneConnectorHostDeps {
  const codec = () =>
    hostService<HostSecretsCodecShape>(ctx, "@cinatra-ai/host:secrets-codec");
  // The EXISTING generic connector-config store — no bespoke host capability.
  const config = () =>
    hostService<HostConnectorConfigShape>(ctx, "@cinatra-ai/host:connector-config");
  return {
    secretsCodec: {
      encryptSecret: (plaintext, aad) => codec().encryptSecret(plaintext, aad),
      decryptSecret: (input, aad) => codec().decryptSecret(input, aad),
    },
    loadInstanceConfig: async () =>
      config().read<PlaneInstanceConfig | null>(INSTANCE_CONFIG_KEY, null),
    saveInstanceConfig: async (instance) => {
      config().write(INSTANCE_CONFIG_KEY, instance);
    },
  };
}

export function register(ctx: ExtensionHostContext): void {
  ctx.capabilities.registerProvider("pm-provider", {
    packageName: PACKAGE_NAME,
    impl: planeConnector,
  });
  // Register the work-item CRUD store behind the SEPARATE `pm-work-store`
  // capability (the "PmConnector v2" seam; cinatra#1031). The capability id is an
  // inlined string literal (host-peer-value-import ban) — this connector never
  // value-imports the id constant nor the SDK PmWorkStore type, so it stays green
  // against the current SDK that does not yet export them (the host store bridge
  // resolves this capability once its SDK contract + binding land). Registering
  // behind an id no host yet resolves is a harmless no-op until then.
  ctx.capabilities.registerProvider("pm-work-store", {
    packageName: PACKAGE_NAME,
    impl: planeWorkStore,
  });
  // Bind the host deps slot. Always-bind: re-activation — incl. a hot-update
  // digest swap — re-binds fresh lazy resolvers, so a stale deps object can
  // never outlive its digest.
  registerPlaneConnector(buildHostBoundDeps(ctx));
}
