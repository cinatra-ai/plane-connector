---
slug: plane
title: Plane integration overview
description: Mirror Cinatra agent-run schedules into Plane work items.
navOrder: 1
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Plane integration overview

The Plane integration makes your Cinatra agent-run schedules visible on a board
your team already watches. When you schedule (or set to recur) an agent run in
Cinatra, the integration mirrors that schedule into [Plane](https://plane.so) —
an open source project-management tool — as a dated **work item**. Anyone who
lives in Plane can now see that a run is coming without logging into Cinatra.

## Who it is for

Teams that plan in Plane and want their automated Cinatra runs to appear next to
the rest of their planned work — on the same board, calendar, and timeline.

## What it lets you do

- **See scheduled runs in Plane.** Each schedule-defining trigger becomes one
  Plane work item, dated to when the run is due (day-level start and target
  dates).
- **Keep Cinatra authoritative.** Cinatra remains the source of truth for the
  schedule and the execution. The Plane work item is a one-way, read-style
  mirror — editing it in Plane never changes anything in Cinatra.
- **Stay resilient.** A Plane outage never breaks a trigger: the connector is
  fail-open, so a run still fires even when Plane is unreachable.

## How it fits together

You configure the connector once with your Plane base URL, workspace slug,
project id, and a user-level Plane API token. From then on, Cinatra upserts a
work item per trigger and reads back its schedule state. The mirror is narrow on
purpose — see [Use it](./use-it.md) for exactly what syncs and what does not.

Ready to set it up? Start with the [quick start](./quick-start.md). For
cross-cutting Cinatra material, see the canonical [Guides](/guides/).
