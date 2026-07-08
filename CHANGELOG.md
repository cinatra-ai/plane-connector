# Changelog

All notable changes to this project are documented here, derived from the
project's merged pull request and release-tag history.

## v0.1.2 — 2026-07-07

- feat(dev-setup): dev-mode provisioning moves into a connector-owned `devSetup` hook conforming to the Cinatra extension devSetup contract — API-key auth preserved, host IO through capability ports (cinatra#976) (#24)
- boundary: the docs-dispatch target comes from a repository variable, removing an internal repository reference from the release workflow (#23)
- No behavior change for installed instances; publishes catalog parity with the current source.

## v0.1.1 — 2026-07-04

- feat: wire the Plane connector setup page into a real connect flow (#16) (#19)
- feat: final connection access-scoping declaration — access fixed to admin-only (cinatra#954 W4) (#22)
- chore: add cinatra.vendor metadata and drop a dead committed lockfile (#18)
- chore(deps): declare cinatra.consumes for closure-gate enrollment (#20)
- docs: improve README to the org standard (#5) (#6); add Integrations hub docs + publish-on-tag + README link (#9); CHANGELOG reconstructed from tag + merged-PR history (#21)
- chore: add CODEOWNERS coverage (#8); strip private tracker references from public source and workflow comments (#12, #15)
- ci: ramp the ui-gate raw-JSX block to error (#10); re-vendor the ui-gate preset with the dynamic-import ban (#11); pin the release workflow to the gated reusable extension-release flow (release-approval wall) (#17)

## v0.1.0 — 2026-06-20

- Release.

## untagged-a67212c94a752fd88898 — 2026-06-20

- feat: implement readTriggerTask read-back for the #319 pre-execution PM check (#2)
