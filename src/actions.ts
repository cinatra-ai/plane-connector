"use server";

// Plane connector setup server action.
//
// The setup page (src/plane-setup-impl.tsx) binds `connectPlaneAction` to its
// <form>. A "use server" action compiles into a SEPARATELY-compiled bundle and
// cannot close over the render-time host `ctx`, so it resolves the host-bound
// deps slot (getPlaneDeps(), bound at register(ctx) activation) — the SAME slot
// the REST layer and MCP handlers use. Authorization is enforced FIRST via the
// host-injected action guard (requireExtensionAction): a `manage` (admin) gate,
// matching the sibling connectors' setup actions. The guard fails closed on a
// denied/absent actor, so a directly-POSTed action can never bypass the page.

import { z } from "zod";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import { getPlaneDeps, type PlaneInstanceConfig } from "./deps";

const PACKAGE_ID = "@cinatra-ai/plane-connector";

// Single-instance connector: one stored instance-config row. `instanceId` is an
// internal tag that ALSO binds the encrypted PAT — it is the AES-GCM additional-
// authenticated-data used at BOTH encrypt (here) and decrypt (plane-rest-call
// resolveInstance). A pre-existing instance therefore keeps its own instanceId
// so a reused PAT envelope stays decryptable.
const DEFAULT_INSTANCE_ID = "plane-default";

const connectSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .min(1, "Base URL is required.")
    .refine((value) => {
      try {
        const url = new URL(value);
        // http is INTENTIONALLY allowed: self-hosted Plane CE commonly runs over
        // http on a private network, and the REST layer already accepts it
        // (plane-rest-call). Forcing https would break the documented
        // self-hosted path.
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    }, "Enter a valid http(s) base URL, for example https://plane.example.com"),
  workspaceSlug: z.string().trim().min(1, "Workspace slug is required."),
  projectId: z.string().trim().min(1, "Project id is required."),
  // Optional on update: leave blank to keep the stored token.
  apiToken: z.string().optional(),
});

/**
 * Connect (or update) the Plane instance from the setup form: validate the
 * input, encrypt the PAT via the host secretsCodec, and persist the instance
 * config through the already-wired saveInstanceConfig. On update, a blank token
 * field keeps the stored (encrypted) PAT. The PAT is never stored in plaintext.
 */
export async function connectPlaneAction(formData: FormData): Promise<void> {
  await requireExtensionAction(PACKAGE_ID, "manage");

  const rawToken = formData.get("apiToken");
  const input = connectSchema.parse({
    baseUrl: String(formData.get("baseUrl") ?? ""),
    workspaceSlug: String(formData.get("workspaceSlug") ?? ""),
    projectId: String(formData.get("projectId") ?? ""),
    apiToken: typeof rawToken === "string" ? rawToken : undefined,
  });

  const deps = getPlaneDeps();
  const existing = await deps.loadInstanceConfig();
  // Preserve an existing instance's id so a reused PAT envelope's AAD matches.
  const instanceId = existing?.instanceId ?? DEFAULT_INSTANCE_ID;

  const token = (input.apiToken ?? "").trim();
  let encryptedPat: PlaneInstanceConfig["encryptedPat"];
  if (token.length > 0) {
    // AAD = instanceId (mirrors the decrypt binding in resolveInstance).
    encryptedPat = deps.secretsCodec.encryptSecret(token, instanceId);
  } else if (existing) {
    encryptedPat = existing.encryptedPat;
  } else {
    throw new Error(
      "An API token is required to connect a Plane instance. Mint a user-level token in Plane (Profile → API Tokens) and paste it here.",
    );
  }

  const config: PlaneInstanceConfig = {
    instanceId,
    // Normalize: strip trailing slashes (projectBase re-appends the REST path).
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    workspaceSlug: input.workspaceSlug,
    projectId: input.projectId,
    encryptedPat,
    updatedAt: new Date().toISOString(),
  };

  await deps.saveInstanceConfig(config);
}
