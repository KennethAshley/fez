# Desktop releases

Build from the private `KennethAshley/fez` repository. Publish only the signed
DMGs, updater archive, and `latest.json` to public `KennethAshley/fez-releases`.
The downloads repository contains its own README and tags; never push source
commits or source tags into it. Extension publishing is separate.

The updater endpoint in `src-tauri/tauri.conf.json` selects the destination for
`scripts/release.sh` too. The script refuses a private destination and uses
GitHub CLI's upload-before-publish behavior, including failed-upload cleanup.

## GitHub Actions setup

Keep the existing Apple signing and Tauri updater secrets in the private source
repository. Add `FEZ_RELEASES_TOKEN` there: a fine-grained GitHub token restricted
to `KennethAshley/fez-releases`, with repository Contents read/write permission.
Renew it before expiry. The default workflow token only reads the private source
repository and its bundled-agent cache; it cannot publish to another repository.

## Cut a release

When the bundled runtime changes, run `FORCE=1 npm run prepare-pi-agent` in
the desktop package. Archive `src-tauri/pi-agent/` as
`pi-agent-macos-arm64-<VERSION>.tar.gz` using the full value in its `VERSION`
file, and upload it to the private `pi-agent-v<PI_VERSION>` cache release.
Each runtime has its own asset so simultaneous releases cannot overwrite
one another's cache. Keep older assets for release retries.

1. Update the version in `package.json`, `package-lock.json`, and
   `src-tauri/tauri.conf.json` together.
2. Run the Fez eval gate and desktop build checks, then push the reviewed commit.
3. Tag that source commit `v<version>` and push the tag to the private source repo.
   Its release workflow builds, signs, notarizes, and publishes the public files.
4. Verify the public DMG and `latest.json` without GitHub authentication. The feed
   must reference the public signed archive for the same version.

For a local release, run `bash packages/fez-desktop/scripts/release.sh` from a
Mac with the signing identity and notarization credentials configured. Authenticate
`gh` with write access to the downloads repository.

## Existing installations

Versions before 0.4.27 have the private updater URL embedded in the app. Install
0.4.27 or later from the public DMG once; subsequent checks use the public feed.
Keep the existing updater signing key so signature verification continues to work.
