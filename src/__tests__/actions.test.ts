// connectPlaneAction — the setup-form server action that wires the connect flow
// (issue #16). Exercises the encrypt-and-persist path against mocked host deps:
//   - a fresh connect encrypts the PAT with the instanceId AAD and saves the
//     full instance config (base URL trailing slash normalized).
//   - an update with a BLANK token reuses the stored encryptedPat AND preserves
//     the existing instanceId (so the reused envelope's AAD still matches).
//   - a fresh connect with no token fails loudly.
//   - an invalid base URL is rejected.
//
// The host action guard is a globalThis-slot the host wires at boot; a unit test
// wires a no-op via `setExtensionActionGuard` so `requireExtensionAction` inside
// the action resolves instead of failing closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setExtensionActionGuard } from "@cinatra-ai/sdk-extensions";
import { connectPlaneAction } from "../actions";
import {
  registerPlaneConnector,
  _resetPlaneDepsForTests,
  type PlaneConnectorHostDeps,
  type PlaneInstanceConfig,
} from "../deps";

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function makeDeps(
  overrides: Partial<PlaneConnectorHostDeps> & {
    encryptSecret?: PlaneConnectorHostDeps["secretsCodec"]["encryptSecret"];
    loadInstanceConfig?: PlaneConnectorHostDeps["loadInstanceConfig"];
  } = {},
): { deps: PlaneConnectorHostDeps; saved: PlaneInstanceConfig[] } {
  const saved: PlaneInstanceConfig[] = [];
  const deps: PlaneConnectorHostDeps = {
    secretsCodec: {
      encryptSecret:
        overrides.encryptSecret ??
        ((plaintext, aad) => ({ ciphertext: `enc(${plaintext}|${aad})`, iv: "iv" })),
      decryptSecret: () => "unused",
    },
    loadInstanceConfig: overrides.loadInstanceConfig ?? (async () => null),
    saveInstanceConfig: async (config) => {
      saved.push(config);
    },
  };
  return { deps, saved };
}

beforeEach(() => {
  // No-op the host authorization guard so the action's requireExtensionAction
  // resolves (the real guard fails closed until the host wires one).
  setExtensionActionGuard(async () => {});
});

afterEach(() => {
  _resetPlaneDepsForTests();
  vi.restoreAllMocks();
});

describe("connectPlaneAction", () => {
  it("encrypts the PAT with the instanceId AAD and saves the normalized instance config", async () => {
    const { deps, saved } = makeDeps();
    registerPlaneConnector(deps);

    await connectPlaneAction(
      formData({
        baseUrl: "https://plane.example.com/",
        workspaceSlug: "acme",
        projectId: "9e051c95-7408-4d4e-896e-c714e02e5713",
        apiToken: "plane_api_smoke",
      }),
    );

    expect(saved).toHaveLength(1);
    const config = saved[0];
    expect(config.instanceId).toBe("plane-default");
    // AAD is the instanceId; trailing slash stripped from the base URL.
    expect(config.encryptedPat).toEqual({
      ciphertext: "enc(plane_api_smoke|plane-default)",
      iv: "iv",
    });
    expect(config.baseUrl).toBe("https://plane.example.com");
    expect(config.workspaceSlug).toBe("acme");
    expect(config.projectId).toBe("9e051c95-7408-4d4e-896e-c714e02e5713");
    expect(typeof config.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(config.updatedAt))).toBe(false);
  });

  it("allows a self-hosted http base URL (self-hosted Plane CE runs over http)", async () => {
    const { deps, saved } = makeDeps();
    registerPlaneConnector(deps);

    await connectPlaneAction(
      formData({
        baseUrl: "http://127.0.0.1:3400",
        workspaceSlug: "cinatra-smoke",
        projectId: "p-1",
        apiToken: "plane_api_local",
      }),
    );

    expect(saved[0].baseUrl).toBe("http://127.0.0.1:3400");
  });

  it("reuses the stored encryptedPat and preserves the instanceId on a blank-token update", async () => {
    const existing: PlaneInstanceConfig = {
      instanceId: "custom-instance-id",
      baseUrl: "https://old.example.com",
      workspaceSlug: "old-ws",
      projectId: "old-project",
      encryptedPat: { ciphertext: "OLD_CT", iv: "OLD_IV" },
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const encryptSecret = vi.fn(() => ({ ciphertext: "NEW_CT", iv: "NEW_IV" }));
    const { deps, saved } = makeDeps({
      encryptSecret,
      loadInstanceConfig: async () => existing,
    });
    registerPlaneConnector(deps);

    await connectPlaneAction(
      formData({
        baseUrl: "https://new.example.com",
        workspaceSlug: "new-ws",
        projectId: "new-project",
        apiToken: "", // blank => keep the stored token
      }),
    );

    expect(encryptSecret).not.toHaveBeenCalled();
    expect(saved[0].encryptedPat).toEqual({ ciphertext: "OLD_CT", iv: "OLD_IV" });
    expect(saved[0].instanceId).toBe("custom-instance-id");
    // Other fields still update.
    expect(saved[0].baseUrl).toBe("https://new.example.com");
    expect(saved[0].workspaceSlug).toBe("new-ws");
    expect(saved[0].projectId).toBe("new-project");
  });

  it("throws when no token is provided and no instance exists yet", async () => {
    const { deps, saved } = makeDeps();
    registerPlaneConnector(deps);

    await expect(
      connectPlaneAction(
        formData({
          baseUrl: "https://plane.example.com",
          workspaceSlug: "acme",
          projectId: "p-1",
          apiToken: "",
        }),
      ),
    ).rejects.toThrow(/API token is required/i);
    expect(saved).toHaveLength(0);
  });

  it("rejects an invalid base URL", async () => {
    const { deps, saved } = makeDeps();
    registerPlaneConnector(deps);

    await expect(
      connectPlaneAction(
        formData({
          baseUrl: "not-a-url",
          workspaceSlug: "acme",
          projectId: "p-1",
          apiToken: "plane_api_x",
        }),
      ),
    ).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });

  it("rejects a missing required field (empty workspace slug)", async () => {
    const { deps, saved } = makeDeps();
    registerPlaneConnector(deps);

    await expect(
      connectPlaneAction(
        formData({
          baseUrl: "https://plane.example.com",
          workspaceSlug: "",
          projectId: "p-1",
          apiToken: "plane_api_x",
        }),
      ),
    ).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
});
