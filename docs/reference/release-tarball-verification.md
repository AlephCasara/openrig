# Building and verifying release tarballs

Use **Node 22 or 24** and npm 10 or later. Node 26 is outside the package's supported engines. Begin with a clean checkout of the release tag; install dependencies according to the repository's lockfile before building.

```sh
npm ci
npm run build:package
npm pack --workspace packages/cli --ignore-scripts --pack-destination ./release-artifacts
```

Do **not** run `npm pack` directly from `packages/cli` before the build. `build:package` compiles and stages the daemon, UI and TUI, rewrites imports of the unpublished daemon package, copies reference docs and generates `build-info.js` in the daemon and CLI distributions. Both stamp files contain the version, Git commit, dirty status and `builtAt` UTC build time. Use a clean release tag to make the other fields reproducible.

The release also publishes an ACP launcher. For both release artifacts and their manifest, use `npm run pack:release -- ./release-artifacts` after the build; see `scripts/pack-release.mjs`.

Obtain the published CLI tarball separately (for example, from an already approved release archive). The following **offline** check uses two existing `.tgz` files; it does not download or publish anything:

```sh
node scripts/compare-release-tarballs.mjs ./release-artifacts/openrig-cli-local.tgz ./release-artifacts/openrig-cli-published.tgz
```

The script compares every packaged file, reports missing or changed paths and fails on any content mismatch except a difference confined to the `builtAt` field in `build-info.js`. It compares extracted file contents rather than gzip metadata. The archive paths are positional and may have different filenames. An unsafe archive entry is rejected. The test fixture runs with `node --test scripts/compare-release-tarballs.test.mjs`.

The command deliberately needs both tarballs available locally. Obtaining the published archive and executing a full release-tag comparison are separate release-operator steps; a comparison against synthetic fixtures is not evidence that an actual published release matches.
