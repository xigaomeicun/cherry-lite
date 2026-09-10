---
description: Cherry-lite packaging runbook — local macOS build by default; optional workflow_dispatch cloud builds; upstream release pipelines neutralized
sources:
  - .github/workflows/build-lite.yml
  - .github/workflows/ci.yml
  - scripts/release/edition.js
  - README.md
---

# Cherry Lite Packaging

This runbook is for **cherry-lite** packaging and optional cloud builds. It replaces the upstream CherryHQ release / backport / publish pipeline, which is neutralized in this fork.

For the branch model, see [Branching Strategy](./branching-strategy.md). Day-to-day ops (install, rollback, TG checklist) live in the local skill `cherrystudio-ops` → `references/cherry-lite.md`.

## Default: local build + overwrite install

```bash
pnpm build:mac:arm64

osascript -e 'quit app "Cherry Studio"' || true
rm -rf "/Applications/Cherry Studio.app"
ditto "dist/mac-arm64/Cherry Studio.app" "/Applications/Cherry Studio.app"
xattr -cr "/Applications/Cherry Studio.app"
open -a "Cherry Studio"
```

Gatekeeper “damaged” dialog:

```bash
sudo xattr -r -d com.apple.quarantine "/Applications/Cherry Studio.app"
```

Do not asar-hotpatch a lite install — rebuild from this checkout instead.

## Optional cloud: workflow_dispatch only

`build-lite.yml` and `ci.yml` are kept as real jobs, but both trigger **only** via `workflow_dispatch` (no push / PR / schedule / `workflow_run`).

```bash
gh workflow run build-lite.yml -R xigaomeicun/cherry-lite   # optional cloud DMG / release
gh workflow run ci.yml -R xigaomeicun/cherry-lite           # optional full CI suite
```

Or: GitHub → Actions → **Build Cherry Lite (macOS)** / **CI** → **Run workflow**.

## Neutralized upstream release surface (do not use)

Kept as empty shells so paths stay stable; they must not be driven for cherry-lite releases:

| Kind | Status |
| --- | --- |
| 21 upstream workflows (everything under `.github/workflows/` except `build-lite.yml` and `ci.yml`) | `workflow_dispatch` + noop job (`neutralized for cherry-lite`) |
| `scripts/release/{backport-patch,compose-release-body,hotfix-release-notes,sync-release-history,validate-edition-artifacts,validate-prepared-release,validate-release-state}.js` | stubs (`module.exports = {}`) |
| `scripts/release/edition.js` | **retained** — real packaging helpers for edition / channel / artifact names |

Do not re-enable or call the neutralized workflows/scripts for publishing. Prefer local `pnpm build:mac:arm64`, or the two optional dispatch workflows above.
