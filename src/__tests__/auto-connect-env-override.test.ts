// The headless auto-connect reads its six values from the host's manifest-declared
// override road when called without a record, and from the passed record otherwise.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlaneAutoConnect } from "../plane-provision";
import { _resetPlaneDepsForTests, getPlaneDeps, registerPlaneConnector } from "../deps";
import type { PlaneConnectorHostDeps } from "../deps";
import { register } from "../register";

const NS = "CINATRA_EXT_CINATRA_HAI_SPLANE_HCONNECTOR__";
const OLD_NAMES = [
  "PLANE_URL",
  "PLANE_ADMIN_EMAIL",
  "PLANE_ADMIN_PASSWORD",
  "PLANE_WORKSPACE_NAME",
  "PLANE_WORKSPACE_SLUG",
  "PLANE_PROJECT_ID",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of OLD_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of OLD_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  _resetPlaneDepsForTests();
});

function fakeCodec() {
  return {
    encryptSecret: (plaintext: string, aad?: string) => ({ ciphertext: `enc:${plaintext}`, iv: aad ?? "" }),
    decryptSecret: (input: { ciphertext: string; iv: string }, aad?: string) => {
      if ((aad ?? "") !== input.iv) throw new Error("AAD mismatch");
      return input.ciphertext.replace(/^enc:/, "");
    },
  };
}

function bindDeps(resolveEnvOverrides?: () => Record<string, string>): void {
  const deps: PlaneConnectorHostDeps = {
    secretsCodec: fakeCodec(),
    loadInstanceConfig: async () => null,
    saveInstanceConfig: async () => {},
    ...(resolveEnvOverrides ? { resolveEnvOverrides } : {}),
  };
  registerPlaneConnector(deps);
}

function makeSpy() {
  return vi.fn(async (..._args: unknown[]) => new Response("", { status: 599 }));
}

function options(spy: ReturnType<typeof makeSpy>) {
  return {
    httpFetch: spy as unknown as typeof fetch,
    loadInstanceConfig: async () => null,
    log: () => {},
  };
}

const REQUIRED = {
  baseUrl: "http://plane.override.test",
  adminEmail: "admin@override.test",
  adminPassword: "override-pw-1",
};

describe("runPlaneAutoConnect without a record (host override road)", () => {
  it("P1 reads the values from the host member", async () => {
    bindDeps(() => ({ ...REQUIRED }));
    const spy = makeSpy();
    const result = await runPlaneAutoConnect(undefined, options(spy));
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toMatch(/^http:\/\/plane\.override\.test\//);
    expect(result.note).toMatch(/could not be probed/);
  });

  it("P2 skips when the admin password is missing", async () => {
    bindDeps(() => ({ baseUrl: REQUIRED.baseUrl, adminEmail: REQUIRED.adminEmail }));
    const spy = makeSpy();
    const result = await runPlaneAutoConnect(undefined, options(spy));
    expect(result.status).toBe("skipped");
    expect(result.connected).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("P3 names the three namespaced variables in the skip note", async () => {
    bindDeps(() => ({}));
    const result = await runPlaneAutoConnect(undefined, options(makeSpy()));
    expect(result.status).toBe("skipped");
    expect(result.note).toContain(`${NS}PLANE_URL`);
    expect(result.note).toContain(`${NS}PLANE_ADMIN_EMAIL`);
    expect(result.note).toContain(`${NS}PLANE_ADMIN_PASSWORD`);
  });

  it("P4 does not read the old process variables", async () => {
    process.env.PLANE_URL = "http://plane.process.test";
    process.env.PLANE_ADMIN_EMAIL = "admin@process.test";
    process.env.PLANE_ADMIN_PASSWORD = "process-pw-4";
    bindDeps(() => ({}));
    const spy = makeSpy();
    const result = await runPlaneAutoConnect(undefined, options(spy));
    expect(result.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("P5 skips softly when the deps slot is not bound", async () => {
    const spy = makeSpy();
    const result = await runPlaneAutoConnect(undefined, options(spy));
    expect(result.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("P6 skips softly when the deps carry no member", async () => {
    bindDeps();
    const spy = makeSpy();
    const result = await runPlaneAutoConnect(undefined, options(spy));
    expect(result.status).toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("runPlaneAutoConnect with a record (development hook road)", () => {
  it("P7 reads the record and ignores the member", async () => {
    bindDeps(() => ({ baseUrl: "http://plane.override.test" }));
    const spy = makeSpy();
    await runPlaneAutoConnect(
      {
        PLANE_URL: "http://plane.record.test",
        PLANE_ADMIN_EMAIL: "admin@record.test",
        PLANE_ADMIN_PASSWORD: "record-pw-7",
      },
      options(spy),
    );
    expect(String(spy.mock.calls[0][0])).toMatch(/^http:\/\/plane\.record\.test\//);
  });
});

describe("the entry's binding and manifest", () => {
  it("P8 register binds the member from the connector-config service", () => {
    const resolveEnvOverrides = vi.fn((_pkg: string) => ({ baseUrl: "http://plane.bound.test" }));
    const impl = { read: vi.fn(), write: vi.fn(), delete: vi.fn(), resolveEnvOverrides };
    const ctx = {
      capabilities: {
        registerProvider: () => {},
        resolveProviders: (capability: string) =>
          capability === "@cinatra-ai/host:connector-config" ? [{ packageName: "host", impl }] : [],
      },
    } as unknown as Parameters<typeof register>[0];
    register(ctx);
    expect(getPlaneDeps().resolveEnvOverrides?.()).toEqual({ baseUrl: "http://plane.bound.test" });
    expect(resolveEnvOverrides).toHaveBeenCalledWith("@cinatra-ai/plane-connector");
  });

  it("P9 the manifest declares the six namespaced overrides", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(manifest.cinatra.envOverrides).toEqual({
      [`${NS}PLANE_URL`]: "settings:baseUrl",
      [`${NS}PLANE_ADMIN_EMAIL`]: "settings:adminEmail",
      [`${NS}PLANE_ADMIN_PASSWORD`]: "secrets:adminPassword",
      [`${NS}PLANE_WORKSPACE_NAME`]: "settings:workspaceName",
      [`${NS}PLANE_WORKSPACE_SLUG`]: "settings:workspaceSlug",
      [`${NS}PLANE_PROJECT_ID`]: "settings:projectId",
    });
    expect(manifest.cinatra.requestedHostPorts).toEqual(["capabilities"]);
  });
});
