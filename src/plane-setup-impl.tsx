// plane-connector setup page implementation.
//
// Admin-only. Shadcn primitives ONLY per the design discipline:
//   - <ConnectorSetupPage> shell (header + Wide content column, sdk-ui)
//   - <Tabs>/<TabsListRow>/<TabsTrigger>/<TabsContent> (sdk-ui, portable —
//     bundled-react connectors ship their own React and cannot import the
//     host app's `@/components/ui/tabs`; see cinatra-ai/cinatra#1103)
//   - <Card> chrome with <CardHeader><CardTitle><CardDescription/></CardHeader><CardContent>
//   - <Input>/<Button> vendored primitives (components/ui) — never raw form controls
//   - semantic tokens only (text-foreground, bg-surface, border-line, ...)
//   - no emojis
//
// Tabbed per design/specs/app-connectors.html §II ("Additional configuration
// tabs" + the reserved Help tab): this connector is single-connection (one
// Plane instance: base URL + workspace slug + project id + PAT), so there is
// no Setup/Connections split (§II "Multiple connections" does not apply) and
// no Connect/Disconnect/Connection-status-card chrome (this connector has no
// OAuth flow — it is a flat connect-by-form Save, the same shape the
// anthropic-connector's un-tabbed Setup fields had before its own tabs pass).
// The existing flat form becomes the (first, Wide) "Setup" tab, unchanged in
// content; a new read-only "Help" tab is appended LAST, per the spec's fixed
// Help-tab position ("Help always sits last, after Setup, after Connections,
// and after every other custom tab").
//
// The connect flow: paste a Plane PAT (user-level token, minted via
// POST /api/users/api-tokens/), the base URL, and the workspace slug + project
// id (explicit mapping, never implicitly derived). `connectPlaneAction` encrypts
// the PAT via the host secretsCodec (never plaintext) and persists it through
// the already-wired saveInstanceConfig. On update, leaving the token field blank
// keeps the stored token. The page reflects connected / not-connected state from
// the persisted instance config; after a save the App-Router form action
// re-renders this server component, so the state updates in place.

import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
import { Tabs, TabsListRow, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";
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

function SetupTabContent({
  instance,
  isConnected,
}: {
  instance: PlaneInstanceConfig | null;
  isConnected: boolean;
}) {
  return (
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
        {isConnected && instance ? (
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
  );
}

// Read-only setup how-to. Reserved tab, always LAST (design spec §II —
// "Help always sits last, after Setup, after Connections, and after every
// other custom tab"). No form, no Save.
function HelpTabContent() {
  return (
    <div className="flex flex-col gap-5 text-sm text-foreground">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          Before you connect
        </h3>
        <p className="text-muted-foreground">
          You need a running Plane instance (self-hosted or Plane Cloud)
          reachable at its base URL, and a workspace + project inside it that
          you are a member of &mdash; membership that lets you create and read
          work items in that project is enough, admin rights are not
          required.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          1. Mint an API token
        </h3>
        <p className="text-muted-foreground">
          In Plane, open your profile and go to API tokens, then create a new
          user-level token (it begins with <code>plane_api_</code>). Paste it
          into the API token field in the Setup tab &mdash; it is encrypted
          before it is stored and is never shown again.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          2. Find your workspace slug
        </h3>
        <p className="text-muted-foreground">
          The workspace slug is the path segment right after your Plane
          host in the browser URL, for example the <code>acme</code> in{" "}
          <code>https://plane.example.com/acme/projects</code>.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          3. Find your project id
        </h3>
        <p className="text-muted-foreground">
          Open the target project in Plane and copy the project UUID from its
          URL or from Project settings &rarr; General.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          4. Base URL
        </h3>
        <p className="text-muted-foreground">
          The root URL of your Plane instance, with no trailing path &mdash;
          for example <code>https://plane.example.com</code> for Plane Cloud
          or self-hosted over https, or <code>http://127.0.0.1:3400</code>{" "}
          for a self-hosted instance reachable over http on a private
          network.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">
          What this connects
        </h3>
        <p className="text-muted-foreground">
          Once connected, cinatra creates and updates work items under the
          chosen workspace/project as trigger runs fire, mapping the trigger
          schedule dates to the work item start and target dates (day-level).
        </p>
      </div>
    </div>
  );
}

export async function PlaneConnectorSetupImpl() {
  const instance = await loadInstance();
  const isConnected = instance !== null;

  return (
    <ConnectorSetupPage
      title="Plane connector"
      description="Configure cinatra's connection to a Plane workspace + project (the pm-provider for run-trigger mirroring)."
      divider={false}
    >
      <Tabs defaultValue="setup">
        <TabsListRow>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="help">Help</TabsTrigger>
        </TabsListRow>
        {/* `forceMount` + `data-[state=inactive]:hidden` keeps the Setup panel
            mounted (merely hidden, not unmounted) while Help is active, so a
            partially-filled connect form is never lost by a round trip
            through the Help tab — the same mount-stability pattern already
            shipped on sibling tabbed connectors (drupal-mcp-connector,
            mcp-client-connector, wordpress-mcp-connector). */}
        <TabsContent
          value="setup"
          forceMount
          className="pt-6 data-[state=inactive]:hidden"
        >
          <SetupTabContent instance={instance} isConnected={isConnected} />
        </TabsContent>
        <TabsContent
          value="help"
          forceMount
          className="max-w-xl pt-6 data-[state=inactive]:hidden"
        >
          <HelpTabContent />
        </TabsContent>
      </Tabs>
    </ConnectorSetupPage>
  );
}
