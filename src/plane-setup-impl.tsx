// plane-connector setup page implementation.
//
// Admin-only. Shadcn primitives ONLY per CLAUDE.md design discipline:
//   - <Main> + <PageHeader> + <PageContent> shell
//   - <Card> chrome with <CardHeader><CardTitle><CardDescription/></CardHeader><CardContent>
//   - semantic tokens only (text-foreground, bg-surface, border-line)
//   - no emojis
//
// The connect flow: paste a Plane PAT (user-level token, minted via
// POST /api/users/api-tokens/), the base URL, pick a workspace slug + project
// (via plane_projects_list — explicit mapping, never implicitly derived). The
// PAT is stored ENCRYPTED via the host secretsCodec (never plaintext). This
// scaffold ships the connector contract + the MCP primitives; the interactive
// connect form is wired host-side via the connector-config surface.

import { Main, PageHeader, PageContent } from "@cinatra-ai/sdk-ui/marketplace";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";

export async function PlaneConnectorSetupImpl() {
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
          <CardContent>
            <p className="text-foreground">
              Work items are created and updated under the chosen
              workspace/project. Trigger schedule dates map to the work item
              start and target dates (day-level).
            </p>
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
