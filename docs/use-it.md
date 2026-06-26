---
slug: plane
title: Use the Plane integration
description: What the Plane mirror does day to day, and what it does not.
navOrder: 3
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Use the Plane integration

Once connected, the integration runs quietly: you keep scheduling agent runs in
Cinatra, and Plane keeps showing them as work items. This page explains what
that mirror does day to day — and, just as importantly, what it does not.

## Cinatra stays authoritative; Plane is the view

Cinatra is the source of truth for the schedule and the execution. The Plane
work item is a one-way, read-style mirror. The schedule flows one direction —
out of Cinatra, into Plane.

## What is mirrored

- **The schedule-defining trigger only.** A scheduled or recurring run has one
  trigger that defines its schedule, and that trigger becomes one work item. A
  recurring run does **not** create a new work item per repeat — one trigger,
  one work item.
- **The dates.** The work item carries a **start date** and a **target date**,
  derived from when the trigger is due. These are calendar (day-level) dates in
  `YYYY-MM-DD` form.
- **The armed/paused state.** A paused schedule still shows up as a work item, so
  the Plane board can reflect that the run is currently paused. The mirror never
  makes a paused run disappear.

## What is not mirrored

- **It is one-way: Cinatra → Plane.** Renaming, re-dating, or closing the work
  item in Plane has no effect on the Cinatra schedule.
- **Plane never controls the run.** Nothing you do in Plane can pause, disable,
  start, or reschedule a Cinatra run. The Plane state is a view, not a control
  surface.
- **Individual recurring executions are not mirrored.** Only the trigger that
  defines the schedule is.

## How the sync stays consistent

- **Idempotent upserts.** Each work item is keyed on the run's id, so a push that
  times out is found and updated on retry rather than duplicated. Duplicate
  reconciliation is best-effort.
- **Read-back of schedule state.** Cinatra reads the trigger's pause / schedule
  state back from Plane. A clean `404` (the work item was deleted in Plane)
  tears the schedule down; any other read error fail-opens, so the trigger still
  fires.
- **Fail-open by design.** A Plane outage never breaks a trigger. If Plane is
  unreachable, the run executes anyway and the mirror catches up later.

## Probing and listing from MCP

The connector exposes MCP primitives you can call to inspect the connection:

- `plane_status` — a health probe for the configured connection.
- `plane_instances_list` — list the configured Plane instances.
- `plane_projects_list` — list the projects visible to your token.

For configuration and the permission model, see
[settings & permissions](./settings-and-permissions.md).
