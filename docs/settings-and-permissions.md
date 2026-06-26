---
slug: plane
title: Plane settings and permissions
description: Configure the Plane connector and understand its trust model.
navOrder: 4
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Plane settings and permissions

This page covers the connector's configuration, the permissions it requires, and
its trust model — what it can access, how that access is granted, and how it is
governed. Read it before you enable the integration.

## Configuration

The connector takes four values, all entered on the connector setup page:

| Setting | What it is | Example |
|---------|------------|---------|
| Base URL | Your Plane instance URL | `https://plane.example.com` |
| Workspace slug | The workspace path segment in Plane | `acme` |
| Project id | The target Plane project (UUID) | `f4c1...` |
| API token | A user-level Plane API token (`plane_api_...`) | minted in Plane |

You mint the API token in Plane under **Profile → API Tokens**. It is a
**user-level** token: work items the connector creates are owned by the user who
minted it, so use an account that is a member of the target workspace and
project.

## Host compatibility

The connector targets **self-hosted Plane CE** (the community stack) and is
verified against **Plane CE v1.3.1**. It authenticates with the `X-API-Key`
header alone (no other auth header is required), and sends day-level dates as
`YYYY-MM-DD`.

## Required permissions

- **In Plane:** the API token must belong to a user who is a **member of the
  workspace** named by the slug and who can **create and read work items** in the
  target project. A token for a non-member, or a wrong project id, is rejected by
  Plane (see the failure modes below).
- **In Cinatra:** the connector requests the `capabilities` host port and runs
  under the standard connector inversion-of-control contract — it cannot reach
  host facilities it has not been granted.

## Trust model

- **The token is encrypted at rest.** The Plane API token is stored encrypted
  (AES-256-GCM under the host instance key) and is decrypted only in-process at
  the moment a request is made; it is then sent to Plane as the `X-API-Key`
  header. It is never logged or persisted in clear text.
- **Scoped to the configured project.** The connector only creates and reads
  work items in the project you configure — it touches nothing else in Plane. It
  reads a work item's schedule state back (the read-back described in
  [Use it](./use-it.md)), and that read-back can only ever **tear down** a
  schedule on a clean `404`; any other read error fail-opens. It never imports
  arbitrary Plane data into Cinatra.
- **Fail-open, never fail-closed on a trigger.** Because the connector is a view,
  a Plane error never blocks a Cinatra run. Authorization failures surface on the
  connection probe, not by silently stopping your automation.

## Failure modes

| Symptom | Cause |
|---------|-------|
| `401` (no header) | The API token is missing from the request. |
| `403` (invalid key) | The token is wrong or expired. |
| `403` (non-member / unknown project) | The token's user is not a member of the workspace, or the project id is unknown. |

Use `plane_status` (an MCP primitive) to probe the connection after any
configuration change. For step-by-step recovery, see
[troubleshooting](./troubleshooting.md).
