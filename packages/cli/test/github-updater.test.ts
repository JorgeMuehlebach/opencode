import { expect, test } from "bun:test"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

test("GitHub release builds use their own update feed and pinned installer through the real updater", async () => {
  await using root = await tmpdir()
  const child = Bun.spawn(
    [
      process.execPath,
      "--define",
      'OPENCODE_UPDATE_REPOSITORY="example/opencode"',
      "--define",
      'OPENCODE_VERSION="2.3.4-fork.1"',
      "--define",
      'OPENCODE_CHANNEL="latest"',
      path.join(import.meta.dir, "fixture/github-updater.ts"),
    ],
    { cwd: path.join(import.meta.dir, ".."), env: isolatedEnv(root.path), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(stdout).toContain("GitHub updater checks passed")
})
