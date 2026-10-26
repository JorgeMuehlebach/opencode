# GitHub release distribution

Custom CLI builds can use GitHub Releases for installation and updates. The release
repository is embedded at build time with `OPENCODE_UPDATE_REPOSITORY=OWNER/REPO`.
Builds without this setting use the standard OpenCode update service.

## Install

Download the `install` asset from the repository's latest release, inspect it, then
run it with the same repository:

```sh
repository=OWNER/REPO
curl -fL "https://github.com/$repository/releases/latest/download/install" -o /tmp/opencode-install
bash /tmp/opencode-install --repository "$repository"
```

The installer selects the native architecture, verifies the archive against the
release's `SHA256SUMS`, and installs to `~/.opencode/bin`. It requires no Bun, Node,
GitHub login or administrator access. Put this directory before any other OpenCode
installation on `PATH`; start a new shell after installation and check
`command -v opencode` and `opencode --version`.

The installer uses the existing OpenCode configuration and data locations. It does
not change provider credentials or project configuration. Close running OpenCode
sessions before switching distributions, then start the installed executable.

## Update

Run `/update` inside the terminal interface, choose **Update**, then restart when
prompted. The terminal equivalent is:

```sh
opencode upgrade
```

These builds check `release.json` attached to their embedded repository's latest
release. They download the installer from the selected version's tag and pass
`--repository` to it. Updates therefore stay with the same distribution. Existing
notification and automatic-update preferences continue to apply.

To install a specific published version, including an earlier release:

```sh
opencode upgrade 2.1.4-fork.1
```

Install through the release installer to use this update path. Package manager
installations continue to belong to their package manager; GitHub release builds
reject package manager upgrades to avoid switching distributions.

## Publish

The `GitHub Release` workflow runs on pull requests affecting distribution files
and can also be run manually for validation without publishing. In forks, pushing
a tag such as `v2.1.4-fork.1` builds and publishes a release:

```sh
git tag v2.1.4-fork.1 <reviewed-commit>
git push origin v2.1.4-fork.1
```

Use the source version followed by an increasing `-fork.N` suffix. The workflow
requires the tagged commit to be on the default branch. It publishes a draft only
after all native build and test jobs pass, uploads every archive plus the installer,
metadata and checksums, then makes the complete release public and marks it latest.
Published assets are not overwritten; publish a new version for a correction.

Releases cover Apple Silicon and Intel macOS, Linux with glibc on x64 and ARM64,
and Windows on x64 and ARM64. x64 releases include baseline variants for older
processors. Windows installation and updates use Git Bash. Linux musl builds are
not included in this workflow. The archives contain the CLI and embedded web UI.

The workflow does not use upstream publishing credentials or Apple Developer ID
certificates. macOS executables are tested on native runners but are not Developer
ID signed or notarized; downloaded binaries may require approval under the
machine's macOS security policy.

Bringing in upstream changes and publishing a release are separate operations.
Review and test upstream updates before tagging the next distribution release.
