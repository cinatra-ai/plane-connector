---
slug: plane
title: Plane troubleshooting
description: Diagnose and fix common Plane integration issues.
navOrder: 5
tier: first-party
lifecycle: active
cinatraCompat: ">=1.2 <2"
integrationVersion: "0.1.0"
sourceRepo: https://github.com/cinatra-ai/plane-connector
supportUrl: https://docs.cinatra.ai/resources/support/
marketplaceUrl: https://marketplace.cinatra.ai/extensions/plane
---

# Plane troubleshooting

Each problem below gives the **symptoms**, the **cause**, the **fix**, the
**diagnostics** to confirm it, and the **escalation** path if the fix does not
work.

## Connection probe returns 401

- **Symptoms:** `plane_status` reports `401`; no work items appear in Plane.
- **Cause:** The request reached Plane without an API key — the token is missing
  from the connector configuration.
- **Fix:** Re-open the connector setup page and re-enter the `plane_api_...`
  token, then save.
- **Diagnostics:** Run `plane_status` again; a `401` becoming a `200` confirms
  the token is now being sent.
- **Escalation:** [Contact support](https://docs.cinatra.ai/resources/support/)
  if the probe still returns `401` after re-saving a known-good token.

## Connection probe returns 403 (invalid key)

- **Symptoms:** `plane_status` reports `403` with an invalid-key indication.
- **Cause:** The token is wrong or has expired.
- **Fix:** Mint a fresh token in Plane under **Profile → API Tokens** and paste
  it into the connector setup page.
- **Diagnostics:** Confirm the token still exists and is active in Plane's API
  Tokens list; re-run `plane_status`.
- **Escalation:** [Contact support](https://docs.cinatra.ai/resources/support/)
  if a brand-new token still returns `403`.

## Connection probe returns 403 (non-member or unknown project)

- **Symptoms:** `plane_status` or work-item creation returns `403`, even though
  the token is valid.
- **Cause:** The token's user is not a member of the configured workspace, or the
  configured project id is unknown.
- **Fix:** Verify the workspace slug and project id, and confirm the token's user
  is a member of that workspace and project. Use `plane_projects_list` to see the
  projects the token can actually reach, then correct the project id if needed.
- **Diagnostics:** `plane_projects_list` returning the expected project confirms
  membership; an empty or different list points to a membership/slug mismatch.
- **Escalation:** [Contact support](https://docs.cinatra.ai/resources/support/)
  if the project is listed but creation still returns `403`.

## A run still fires when Plane is down

- **Symptoms:** A Cinatra run executed even though Plane was unreachable and no
  work item was created.
- **Cause:** This is by design — the connector is **fail-open**, so a Plane
  outage never blocks a trigger.
- **Fix:** No action needed. Once Plane is reachable again, the next upsert
  reconciles the work item.
- **Diagnostics:** Run `plane_status` after Plane recovers; a healthy probe plus
  a present work item confirms the mirror caught up.
- **Escalation:** [Contact support](https://docs.cinatra.ai/resources/support/)
  if the work item does not reappear after Plane is back and a trigger has fired.

## A duplicate work item appeared

- **Symptoms:** Two work items exist for the same scheduled run.
- **Cause:** A first push timed out before its response returned, and retry
  reconciliation was incomplete (reconciliation is best-effort, keyed on the run
  id).
- **Fix:** Close the duplicate in Plane. Future pushes for that run id update the
  surviving item idempotently.
- **Diagnostics:** Both items share the same run id in their content; confirm
  which one the next sync updates.
- **Escalation:** [Contact support](https://docs.cinatra.ai/resources/support/)
  if duplicates keep reappearing for the same run id.

For configuration details and the permission model, see
[settings & permissions](./settings-and-permissions.md).
