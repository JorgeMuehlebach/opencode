import { expect, test } from "bun:test"
import { chmod, mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

const installer = path.join(import.meta.dir, "../../../install")
const repository = "example/opencode"
const release = `https://github.com/${repository}/releases/download/v2.1.4-fork.1`
const bash =
  process.platform === "win32"
    ? path.resolve(Bun.spawnSync(["git", "--exec-path"]).stdout.toString().trim(), "../../../bin/bash.exe")
    : "bash"

async function fixture(root: string, target = "darwin-arm64") {
  await mkdir(path.join(root, "tools"))
  await mkdir(path.join(root, "home", ".opencode", "bin"), { recursive: true })
  await mkdir(path.join(root, "package", "bin"), { recursive: true })
  await Bun.write(path.join(root, "install"), Bun.file(installer))
  await Bun.write(path.join(root, "package", "bin", "opencode"), "new executable\n")
  await Bun.write(path.join(root, "package", "bin", "opencode.exe"), "new executable\n")
  await Bun.write(path.join(root, "package", "package.json"), '{"version":"2.1.4-fork.1"}')
  await Bun.write(path.join(root, "package", "unrelated"), "do not extract")
  const archive = Bun.spawn(["tar", "-czf", "archive.tgz", "package"], { cwd: root, stderr: "pipe" })
  const [code, stderr] = await Promise.all([archive.exited, new Response(archive.stderr).text()])
  expect(code, stderr).toBe(0)
  await Bun.write(
    path.join(root, "SHA256SUMS"),
    `${new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(root, "archive.tgz")).arrayBuffer()).digest("hex")}  cli-${target}.tgz\n`,
  )
  await Bun.write(
    path.join(root, "tools", "uname"),
    '#!/usr/bin/env bash\nif [[ "$1" == "-s" ]]; then echo "${TEST_OS:-Darwin}"; else echo "${TEST_ARCH:-arm64}"; fi\n',
  )
  await Bun.write(path.join(root, "tools", "sysctl"), '#!/usr/bin/env bash\necho "${TEST_SYSCTL:-0}"\n')
  await Bun.write(path.join(root, "tools", "ldd"), '#!/usr/bin/env bash\necho "${TEST_LDD:-glibc}"\n')
  await Bun.write(
    path.join(root, "tools", "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 1 ]]; do
    case "$1" in
        -o) output="$2"; shift 2 ;;
        -w) shift 2 ;;
        *) shift ;;
    esac
done
url="$1"
printf '%s\\n' "$url" >> "$CLI_TEST_ROOT/requests"
case "$url" in
    */releases/latest) printf '%s' "https://github.com/example/opencode/releases/tag/\${TEST_TAG:-v2.1.4-fork.1}" ;;
    */SHA256SUMS)
        [[ "\${TEST_FAILURE:-}" != checksum-download ]] || exit 22
        cp "$CLI_TEST_ROOT/SHA256SUMS" "$output"
        ;;
    *.tgz)
        [[ "\${TEST_FAILURE:-}" != archive-download ]] || exit 22
        cp "$CLI_TEST_ROOT/archive.tgz" "$output"
        ;;
    https://opencode.ai/update/api/latest/cli/npm) echo '{"version":"2.1.4-fork.1","package":"@opencode/cli"}' ;;
    https://registry.npmjs.org/*) printf 200 ;;
    *) echo "Unexpected URL: $url" >&2; exit 1 ;;
esac
`,
  )
  await Promise.all(["curl", "uname", "sysctl", "ldd"].map((name) => chmod(path.join(root, "tools", name), 0o755)))
  return {
    binary: path.join(root, "home", ".opencode", "bin", "opencode"),
    async run(args: string[], overrides: Record<string, string> = {}) {
      const child = Bun.spawn(
        [
          bash,
          "-c",
          'export HOME="$PWD/home" CLI_TEST_ROOT="$PWD" PATH="$PWD/tools:/usr/bin:/bin"; exec bash "$PWD/install" "$@"',
          "install",
          ...args,
        ],
        {
          cwd: root,
          env: isolatedEnv(path.join(root, "home"), {
            VERSION: "",
            GITHUB_ACTIONS: "",
            SHELL: "/bin/zsh",
            ZDOTDIR: undefined,
            ...overrides,
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, output: stdout + stderr }
    },
    async requests() {
      return (await Bun.file(path.join(root, "requests")).text()).trim().split("\n")
    },
  }
}

test("Apple Silicon installs a verified release and adds the existing shell PATH entry", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path)
  const result = await install.run(["--repository", repository, "--version", "v2.1.4-fork.1"])
  expect(result.code, result.output).toBe(0)
  expect(await Bun.file(install.binary).text()).toBe("new executable\n")
  if (process.platform !== "win32") expect((await stat(install.binary)).mode & 0o777).toBe(0o755)
  expect(await install.requests()).toEqual([`${release}/cli-darwin-arm64.tgz`, `${release}/SHA256SUMS`])
  expect(await readdir(path.dirname(install.binary))).toEqual(expect.arrayContaining(["opencode", "opencode2"]))
  expect(await Bun.file(path.join(dir.path, "home", ".zshrc")).text()).toContain("export PATH=")
  expect(await readdir(path.join(dir.path, "home", ".opencode"))).toEqual(["bin"])
})

test("latest is resolved once before archive and checksums are downloaded from the same release", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path)
  const result = await install.run(["--repository", repository, "--no-modify-path"])
  expect(result.code, result.output).toBe(0)
  expect(await install.requests()).toEqual([
    `https://github.com/${repository}/releases/latest`,
    `${release}/cli-darwin-arm64.tgz`,
    `${release}/SHA256SUMS`,
  ])
  expect(await Bun.file(path.join(dir.path, "home", ".zshrc")).exists()).toBe(false)
  expect(await readdir(path.dirname(install.binary))).not.toContain("package")
})

test("Intel Macs retain the installer's baseline CPU selection", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path, "darwin-x64-baseline")
  const result = await install.run(["--repository", repository, "--version", "2.1.4-fork.1", "--no-modify-path"], {
    TEST_ARCH: "x86_64",
  })
  expect(result.code, result.output).toBe(0)
  expect(await install.requests()).toEqual([`${release}/cli-darwin-x64-baseline.tgz`, `${release}/SHA256SUMS`])
})

test.each([
  { target: "linux-arm64-musl", os: "Linux", arch: "aarch64", binary: "opencode" },
  { target: "windows-arm64", os: "MINGW64_NT-10.0-ARM64", arch: "x86_64", binary: "opencode.exe" },
])("$target retains the installer's platform selection", async ({ target, os, arch, binary }) => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path, target)
  const result = await install.run(["--repository", repository, "--version", "2.1.4-fork.1", "--no-modify-path"], {
    TEST_OS: os,
    TEST_ARCH: arch,
    TEST_LDD: "musl",
  })
  expect(result.code, result.output).toBe(0)
  expect(await install.requests()).toEqual([`${release}/cli-${target}.tgz`, `${release}/SHA256SUMS`])
  expect(await Bun.file(path.join(path.dirname(install.binary), binary)).text()).toBe("new executable\n")
})

test.each(["checksum", "missing-checksum", "duplicate-checksum", "checksum-download", "archive-download"])(
  "%s failure preserves the installed executable",
  async (failure) => {
    await using dir = await tmpdir()
    const install = await fixture(dir.path)
    await Bun.write(install.binary, "previous executable")
    if (failure === "checksum")
      await Bun.write(path.join(dir.path, "SHA256SUMS"), `${"0".repeat(64)}  cli-darwin-arm64.tgz\n`)
    if (failure === "missing-checksum") await Bun.write(path.join(dir.path, "SHA256SUMS"), "")
    if (failure === "duplicate-checksum")
      await Bun.write(
        path.join(dir.path, "SHA256SUMS"),
        (await Bun.file(path.join(dir.path, "SHA256SUMS")).text()).repeat(2),
      )
    const result = await install.run(["--repository", repository, "--version", "2.1.4-fork.1", "--no-modify-path"], {
      TEST_FAILURE: failure,
    })
    expect(result.code, result.output).not.toBe(0)
    expect(await Bun.file(install.binary).text()).toBe("previous executable")
    expect(await readdir(path.dirname(install.binary))).toEqual(["opencode"])
  },
)

test("an archive missing the expected executable preserves the installed executable", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path)
  await Bun.write(install.binary, "previous executable")
  const archive = Bun.spawn(["tar", "-czf", "archive.tgz", "package/package.json"], { cwd: dir.path, stderr: "pipe" })
  const [code, stderr] = await Promise.all([archive.exited, new Response(archive.stderr).text()])
  expect(code, stderr).toBe(0)
  await Bun.write(
    path.join(dir.path, "SHA256SUMS"),
    `${new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(dir.path, "archive.tgz")).arrayBuffer()).digest("hex")}  cli-darwin-arm64.tgz\n`,
  )
  const result = await install.run(["--repository", repository, "--version", "2.1.4-fork.1", "--no-modify-path"])
  expect(result.code, result.output).not.toBe(0)
  expect(await Bun.file(install.binary).text()).toBe("previous executable")
  expect(await readdir(path.dirname(install.binary))).toEqual(["opencode"])
})

test("invalid repository and version inputs fail before downloading or replacing anything", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path)
  await Bun.write(install.binary, "previous executable")
  for (const args of [
    ["--repository", "https://github.com/example/opencode"],
    ["--repository", "example/../opencode"],
    ["--repository", "example/.."],
    ["--repository", repository, "--version", "2.1"],
    ["--repository", repository, "--version", "01.2.3"],
    ["--repository", repository, "--version", "2.1.4-fork.01"],
    ["--repository", repository, "--version", "2.1.4;echo unsafe"],
  ]) {
    const result = await install.run(args)
    expect(result.code, result.output).not.toBe(0)
  }
  expect(await Bun.file(install.binary).text()).toBe("previous executable")
  expect(await Bun.file(path.join(dir.path, "requests")).exists()).toBe(false)
})

test("omitting repository preserves the official npm release source", async () => {
  await using dir = await tmpdir()
  const install = await fixture(dir.path)
  const result = await install.run(["--no-modify-path"])
  expect(result.code, result.output).toBe(0)
  expect(await install.requests()).toEqual([
    "https://opencode.ai/update/api/latest/cli/npm",
    "https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/2.1.4-fork.1",
    "https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.1.4-fork.1.tgz",
  ])
  expect(await Bun.file(install.binary).text()).toBe("new executable\n")
})
