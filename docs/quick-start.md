---
slug: plane
title: Plane quick start
description: Connect Cinatra to Plane and mirror your first scheduled run.
navOrder: 2
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Plane quick start

This page is everything you need to connect Cinatra to Plane and see your first
scheduled run appear as a Plane work item. You can finish setup here without
leaving the page.

## Before you start

You need:

- A **Plane** workspace and project you are a **member of** (self-hosted Plane
  CE, verified against v1.3.1). Admin rights are not required — membership that
  lets you create and read work items in the target project is enough.
- The **Plane base URL** of your instance, for example
  `https://plane.example.com`.
- The **workspace slug** — the path segment in your Plane URL after the host,
  for example `acme` in `https://plane.example.com/acme/`.
- The **project id** of the Plane project you want the work items to land in.
  Open the project in Plane; the id is the UUID in the project URL.
- Permission in Cinatra to install an integration and configure a connector.

## Step 1 — Mint a Plane API token

1. In Plane, open **Profile → API Tokens**.
2. Create a new token. Plane shows it once — it begins with `plane_api_`.
3. Copy the token now; you will paste it into Cinatra in Step 3.

The token is **user-level**: the work items the connector creates are owned by
the user who minted it, so use a token from an account that is a member of the
target workspace and project.

## Step 2 — Install the integration

1. Open the Cinatra **Marketplace** and find the **Plane** integration.
2. Click **Install**. This adds the connector to your Cinatra instance.

## Step 3 — Configure the connector

1. In Cinatra, open the **Plane** connector setup page.
2. Enter the four values:
   - **Base URL** — your Plane instance, e.g. `https://plane.example.com`
   - **Workspace slug** — e.g. `acme`
   - **Project id** — the project UUID
   - **API token** — the `plane_api_...` token from Step 1
3. Click **Save**. Cinatra stores the token encrypted at rest and verifies the
   connection.

## Step 4 — Mirror a scheduled run

1. Create or open a **scheduled (or recurring) agent run** in Cinatra and arm
   its schedule.
2. Within moments, a matching **work item** appears in your Plane project, dated
   to when the run is due (start date and target date, day-level).

That is the whole setup. Cinatra now mirrors each schedule-defining trigger into
Plane as a dated work item, and keeps it in sync one way (Cinatra → Plane).

## Verify it worked

Run the `plane_status` health probe (available through the connector's MCP
primitives) to confirm Cinatra can reach Plane with your token. A green status
plus a visible work item in your project means you are done.

If something does not line up, see [troubleshooting](./troubleshooting.md).
