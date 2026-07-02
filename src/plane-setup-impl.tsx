// plane-connector setup page implementation.
//
// Admin-only. Shadcn primitives ONLY per the design discipline:
//   - <Main> + <PageHeader> + <PageContent> shell
//   - <Card> chrome with <CardHeader><CardTitle><CardDescription/></CardHeader><CardContent>
//   - <Input>/<Button> vendored primitives (components/ui) — never raw form controls
//   - semantic tokens only (text-foreground, bg-surface, border-line, ...)
//   - no emojis
//
// The connect flow: paste a Plane PAT (user-level token, minted via
// POST /api/users/api-tokens/), the base URL, and the workspace slug + project
// id (explicit mapping, never implicitly derived). `connectPlaneAction` encrypts
// the PAT via the host secretsCodec (never plaintext) and persists it through
// the already-wired saveInstanceConfig. On update, leaving the token field blank
// keeps the stored token. The page reflects connected / not-connected state from
// the persisted instance config; after a save the App-Router form action
// re-renders this server component, so the state updates in place.

import { Main, PageHeader, PageContent } from "@cinatra-ai/sdk-ui/marketplace";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { connectPlaneAction } from "./actions";
import { getPlaneDeps, type PlaneInstanceConfig } from "./deps";

async function loadInstance(): Promise<PlaneInstanceConfig | null> {
  // The deps slot is bound at register(ctx) activation, which precedes render.
  // Degrade to "not connected" (never white-screen) if it is somehow unbound —
  // the same posture plane_status uses for a config read (mcp/handlers).
  try {
    return await getPlaneDeps().loadInstanceConfig();
  } catch {
    return null;
  }
}

function ConnectedSummary({ instance }: { instance: PlaneInstanceConfig }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Status", value: "Connected" },
    { label: "Base URL", value: instance.baseUrl },
    { label: "Workspace slug", value: instance.workspaceSlug },
    { label: "Project id", value: instance.projectId },
    { label: "API token", value: "Stored (encrypted)" },
    { label: "Last updated", value: instance.updatedAt },
  ];
  return (
    <dl className="grid gap-3 rounded-lg border border-line bg-surface-strong p-4 text-sm sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-all font-medium text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export async function PlaneConnectorSetupImpl() {
  const instance = await loadInstance();
  const isConnected = instance !== null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Plane connector"
        description="Configure cinatra's connection to a Plane workspace + project (the pm-provider for run-trigger mirroring)."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription className="text-muted-foreground">
              Connect a Plane instance by base URL, paste a user-level API token
              (minted in Plane under your profile API tokens), then choose the
              workspace and project to mirror run triggers into. The token is
              stored encrypted at rest and is used only as the X-API-Key
              authenticator on server-to-server calls.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {isConnected ? (
              <ConnectedSummary instance={instance} />
            ) : (
              <p className="text-muted-foreground">
                No Plane instance is connected yet. Enter your instance details
                below to connect. Work items are then created and updated under
                the chosen workspace/project, and trigger schedule dates map to
                the work item start and target dates (day-level).
              </p>
            )}

            <form action={connectPlaneAction} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="plane-base-url"
                  className="text-sm font-medium text-foreground"
                >
                  Base URL
                </label>
                <Input
                  id="plane-base-url"
                  name="baseUrl"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://plane.example.com"
                  defaultValue={instance?.baseUrl ?? ""}
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="plane-workspace-slug"
                  className="text-sm font-medium text-foreground"
                >
                  Workspace slug
                </label>
                <Input
                  id="plane-workspace-slug"
                  name="workspaceSlug"
                  autoComplete="off"
                  placeholder="acme"
                  defaultValue={instance?.workspaceSlug ?? ""}
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="plane-project-id"
                  className="text-sm font-medium text-foreground"
                >
                  Project id
                </label>
                <Input
                  id="plane-project-id"
                  name="projectId"
                  autoComplete="off"
                  placeholder="the project UUID from its Plane URL"
                  defaultValue={instance?.projectId ?? ""}
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="plane-api-token"
                  className="text-sm font-medium text-foreground"
                >
                  API token
                </label>
                <Input
                  id="plane-api-token"
                  name="apiToken"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    isConnected
                      ? "Leave blank to keep the stored token"
                      : "plane_api_..."
                  }
                  required={!isConnected}
                />
                <span className="text-xs text-muted-foreground">
                  User-level Plane API token (begins with plane_api_). Stored
                  encrypted at rest; never displayed after saving.
                </span>
              </div>

              <div>
                <Button type="submit">Save</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
