# CAP-025 - Package Cappy as one scoped CLI distribution

**Status:** Complete
**Depends on:** CAP-024.

## Work

Follow SPEC sections 26.4-26.5: rename all private workspaces/imports and regenerate
the lockfile; add `packages/cappy` as the only public workspace; bundle the CLI
and internal modules, retaining declared registry runtime dependencies. Set the
bin, version, metadata, license, and explicit package contents. Update consumer
installation, contributor commands, addon retrieval, and architecture docs.

## Done when

The public package installs without a checkout or build step, exposes `cappy`,
and contains no private/local dependency references. All existing implementation
and fixture packages remain private. Current documentation uses the approved
ownership and scoped installation path. No product behavior is changed.

## Verification

Run typecheck, lint, tests, model validation, distribution build, and whitespace
checks. Inspect the package manifest and tarball contents. Installation and
behavioral evidence are completed separately in CAP-026.

## Outcome

Completed 2026-09-28. Eight private workspaces/imports now use Uppercut Labs
internal/fixture names; the root remains private. `packages/cappy` is the only
public package, with a bundled ESM `cappy` executable, Node >=24, public metadata,
MIT license, and only `ws`/`zod` runtime dependencies. Consumer docs use the
scoped package; contributor docs use the checkout launcher. Typecheck, lint,
model, build, and the normal suite pass on all three hosts. The tested package
contains four files and installs without any consumer build step.
