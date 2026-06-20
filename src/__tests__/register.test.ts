// register(ctx) registers the Plane PmConnector behind the `pm-provider`
// capability and binds the host deps slot — mirrors twenty-connector's
// register.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../register";
import { planeConnector } from "../plane-connector";
import { _resetPlaneDepsForTests, getPlaneDeps } from "../deps";

type RegisteredProvider = { packageName: string; impl: unknown };

function makeCtx(services: Record<string, unknown>) {
  const registered: Record<string, RegisteredProvider[]> = {};
  return {
    ctx: {
      capabilities: {
        registerProvider: (capability: string, provider: RegisteredProvider) => {
          (registered[capability] ??= []).push(provider);
        },
        resolveProviders: (capability: string): RegisteredProvider[] => {
          const svc = services[capability];
          return svc ? [{ packageName: "host", impl: svc }] : [];
        },
      },
    } as unknown as Parameters<typeof register>[0],
    registered,
  };
}

afterEach(() => {
  _resetPlaneDepsForTests();
});

describe("plane-connector register(ctx)", () => {
  it("registers the planeConnector behind the pm-provider capability", () => {
    const { ctx, registered } = makeCtx({});
    register(ctx);
    expect(registered["pm-provider"]).toHaveLength(1);
    expect(registered["pm-provider"][0].packageName).toBe("@cinatra-ai/plane-connector");
    expect(registered["pm-provider"][0].impl).toBe(planeConnector);
  });

  it("binds host deps that lazily resolve the secrets-codec + generic connector-config store", async () => {
    const decryptSecret = vi.fn(() => "plane_api_x");
    const read = vi.fn((_k: string, fallback: unknown) => fallback);
    const write = vi.fn();
    const { ctx } = makeCtx({
      "@cinatra-ai/host:secrets-codec": {
        encryptSecret: () => ({ ciphertext: "c", iv: "i" }),
        decryptSecret,
      },
      "@cinatra-ai/host:connector-config": { read, write, delete: vi.fn() },
    });
    register(ctx);
    const deps = getPlaneDeps();
    // Lazy resolution — building the deps did not call the host services yet.
    expect(decryptSecret).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    // Calling a member resolves the host service at call time.
    deps.secretsCodec.decryptSecret({ ciphertext: "c", iv: "i" }, "aad");
    expect(decryptSecret).toHaveBeenCalledOnce();
    // loadInstanceConfig reads the namespaced instance row via the generic store.
    expect(await deps.loadInstanceConfig()).toBeNull();
    expect(read).toHaveBeenCalledWith("@cinatra-ai/plane-connector:instance", null);
    // saveInstanceConfig writes the namespaced instance row via the generic store.
    // NOTE (#366): the connector keeps NO runId→taskId mapping — the host owns
    // the pm-link table — so there is no run-task key write here.
    const instance = {
      instanceId: "plane-default",
      baseUrl: "http://127.0.0.1:3400",
      workspaceSlug: "ws",
      projectId: "p",
      encryptedPat: { ciphertext: "c", iv: "i" },
      updatedAt: "2026-06-19T00:00:00.000Z",
    };
    await deps.saveInstanceConfig(instance);
    expect(write).toHaveBeenCalledWith("@cinatra-ai/plane-connector:instance", instance);
  });

  it("a deps member throws a clear error when its host service is missing", () => {
    const { ctx } = makeCtx({}); // no services registered
    register(ctx);
    const deps = getPlaneDeps();
    expect(() => deps.secretsCodec.decryptSecret({ ciphertext: "c", iv: "i" })).toThrow(
      /host service "@cinatra-ai\/host:secrets-codec" is not registered/,
    );
  });
});
