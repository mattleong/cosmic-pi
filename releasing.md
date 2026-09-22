# Releasing cosmic-pi

All workspace packages use the same version. The public `pi-ask-user`, `pi-background-task`, `pi-better-openai`, `pi-better-xai`, `pi-code-mode`, `pi-code-previews`, `pi-cosmic-core`, `pi-cosmic-ui`, `pi-directory-models`, and `pi-subagents` packages are published together; private `pi-herdr-btw` and `pi-mcp` remain local-only, and the nested private `pi-code-mode-runtime` is never published on its own (its TypeScript source ships inside the `pi-code-mode` tarball and loads through Pi/Jiti). A published GitHub Release triggers [the release workflow](.github/workflows/release.yml), which validates the entire workspace, skips private packages, and publishes each public package to npm — shared runtime dependencies (`pi-cosmic-core`, `pi-cosmic-ui`, `pi-code-previews`) first, then the remaining public packages.

## One-time setup

Before the first release:

1. Create and push the `mattleong/cosmic-pi` GitHub repository.
2. On npm, configure trusted publishing for every public package:
   - `pi-ask-user`
   - `pi-background-task`
   - `pi-better-openai`
   - `pi-better-xai`
   - `pi-code-mode`
   - `pi-code-previews`
   - `pi-cosmic-core`
   - `pi-cosmic-ui`
   - `pi-directory-models`
   - `pi-subagents`
3. For each npm package, set the trusted publisher to:
   - **Organization or user:** `mattleong`
   - **Repository:** `cosmic-pi`
   - **Workflow:** `release.yml`
4. Ensure the GitHub workflow is enabled on the default branch.

The workflow uses GitHub OIDC and npm provenance. It does not require an `NPM_TOKEN` secret when trusted publishing is configured.

When a new package becomes public (most recently `pi-code-mode`), configure its npm trusted publisher **before tagging** the first release that includes it; a tag pushed first will fail to publish that package until trusted publishing is configured and the workflow is retried.

## Prepare a release

Start from an up-to-date, clean `main` branch:

```bash
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm validate
```

Choose a stable version that is newer than every version already published for any public npm package. npm versions are immutable and cannot be overwritten.

Update every workspace package to the new version:

```bash
pnpm version:set 0.2.1
pnpm version:check
pnpm validate
```

Review the changes. The root and all package manifests should have the same version:

```bash
git diff -- package.json packages/*/package.json packages/pi-code-mode/runtime/package.json
git status --short
```

Commit and push the release version:

```bash
git add package.json packages/*/package.json packages/pi-code-mode/runtime/package.json
git commit -m "chore(release): v0.2.1"
git push origin main
```

## Tag and publish the GitHub Release

Create a tag that exactly matches the package version with a leading `v`:

```bash
git tag -a v0.2.1 -m "v0.2.1"
git push origin v0.2.1
```

Create and publish the GitHub Release from that tag. With the GitHub CLI:

```bash
gh release create v0.2.1 \
  --verify-tag \
  --generate-notes \
  --title "v0.2.1"
```

Publishing the GitHub Release triggers the npm workflow. Creating only a Git tag or a draft GitHub Release does not publish packages.

## Verify publication

Watch the **Publish npm packages** workflow in GitHub Actions. After it succeeds, verify every public package version:

```bash
npm view pi-ask-user version
npm view pi-background-task version
npm view pi-better-openai version
npm view pi-better-xai version
npm view pi-code-mode version
npm view pi-code-previews version
npm view pi-cosmic-core version
npm view pi-cosmic-ui version
npm view pi-directory-models version
npm view pi-subagents version
```

All ten commands should report the release version. npm provenance should also appear on each package version page.

## Retry a failed release

The workflow is retry-safe. It always skips private packages. Before publishing a public package, it checks whether that exact package version already exists on npm and skips versions that were successfully published by an earlier attempt.

You can rerun the failed workflow in GitHub Actions. Alternatively, manually dispatch **Publish npm packages** and provide the existing tag, for example `v0.2.1`.

Do not create a new version solely because one package published before another failed. Retry the workflow with the same tag first.

## Important constraints

- Keep the root and every package version synchronized.
- Keep `pi-herdr-btw` and `pi-mcp` private and local-only; do not publish them to npm.
- Use stable `vMAJOR.MINOR.PATCH` release tags, such as `v0.2.1`.
- Publish through the GitHub Release workflow rather than running `npm publish` locally.
- Never reuse or move a tag after npm publication.
- Never attempt to replace an existing npm version; increment the shared version instead.
