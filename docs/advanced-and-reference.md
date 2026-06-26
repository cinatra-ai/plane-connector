---
slug: plane
title: Plane advanced and reference
description: Deeper material and canonical reference links for the Plane integration.
navOrder: 6
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Plane advanced and reference

This page collects deeper material and links out to the canonical Cinatra
chapters — it does not duplicate them.

## The provider-neutral PM connector

The Plane integration is one provider behind Cinatra's provider-neutral **PM
connector** contract. Cinatra defines a single connector shape — "mirror this
trigger to a work item", "delete this work item", "read back the trigger" — and
a provider registry the host resolves at runtime. Plane is the provider today;
the contract is deliberately neutral so other tools can be added later without
changing how scheduling works in Cinatra.

For the cross-cutting platform reference, see the canonical
[References](/references/) chapter, and for the user-facing scheduling story see
the [Guides](/guides/).

## Date and field semantics

- Dates are **day-level** and sent as `YYYY-MM-DD`.
- The connector sends a **start date** and a **target date** derived from when
  the trigger is due. It never sends `due_date` — Plane silently drops it, so the
  target date carries the due semantics instead.

## MCP primitives

The connector exposes these primitives over MCP for inspection and diagnostics:

- `plane_status` — probe the configured connection's health.
- `plane_instances_list` — list configured Plane instances.
- `plane_projects_list` — list the projects the configured token can reach.

## Host compatibility reference

- **Plane:** self-hosted Plane CE, verified against **v1.3.1**. Authentication is
  the `X-API-Key` header alone. Tokens are minted under **Profile → API Tokens**
  and begin with `plane_api_`.
- **Cinatra:** see the `cinatraCompat` range in this page's footer for the
  supported Cinatra version range.

## Source and support

- Source repository: [cinatra-ai/plane-connector](https://github.com/cinatra-ai/plane-connector).
- Get help: the [support](https://docs.cinatra.ai/resources/support/) page.
- Marketplace listing: [Plane on the Cinatra Marketplace](https://marketplace.cinatra.ai/extensions/plane).
