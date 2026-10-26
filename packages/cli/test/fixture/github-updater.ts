import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Updater } from "../../src/services/updater"
import { fixture } from "./updater"

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const installed = (root: string, home: string) =>
        Effect.succeed(path.join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"))
      const setup = (response = () => Response.json({ version: "2.3.4-fork.2" })) =>
        fixture(undefined, undefined, false, undefined, undefined, installed, response)
      const test = yield* setup()
      expect(yield* test.updater.method()).toBe("curl")
      expect(yield* test.updater.check()).toEqual({ type: "available", version: "2.3.4-fork.2" })
      expect(test.requests).toEqual(["https://github.com/example/opencode/releases/latest/download/release.json"])
      yield* test.updater.apply("2.3.4-fork.2")
      expect(test.commands).toEqual([
        [
          "curl",
          "-fsSL",
          "-o",
          expect.any(String),
          "https://github.com/example/opencode/releases/download/v2.3.4-fork.2/install",
        ],
        [
          test.bash,
          expect.any(String),
          "--version",
          "2.3.4-fork.2",
          "--no-modify-path",
          "--repository",
          "example/opencode",
        ],
      ])
      expect(yield* test.fs.readDirectory(test.global.cache)).toEqual([])
      expect(yield* test.updater.check()).toEqual({ type: "installed", version: "2.3.4-fork.2" })
      test.commands.length = 0
      test.requests.length = 0
      yield* test.updater.upgrade("curl", "v2.3.4-fork.1")
      expect(test.requests).toEqual([])
      expect(test.commands[0]?.at(-1)).toBe(
        "https://github.com/example/opencode/releases/download/v2.3.4-fork.1/install",
      )
      test.commands.length = 0
      for (const method of Updater.methods.filter((method) => method !== "curl")) {
        expect((yield* test.updater.latest(method).pipe(Effect.flip)).message).toContain("--method curl")
        expect((yield* test.updater.upgrade(method, "2.3.4-fork.2").pipe(Effect.flip)).message).toContain(
          "--method curl",
        )
      }
      expect(test.commands).toEqual([])
      expect(test.requests).toEqual([])
      for (const data of [{}, { version: 42 }, { version: "../../other" }, { version: "not-semver" }]) {
        const invalid = yield* setup(() => Response.json(data))
        yield* invalid.updater.check().pipe(Effect.flip)
        expect(invalid.commands).toEqual([])
      }
      const failed = yield* setup(() => new Response("unavailable", { status: 503 }))
      expect((yield* failed.updater.check().pipe(Effect.flip)).message).toContain("HTTP 503")
      expect(failed.commands).toEqual([])
      console.log("GitHub updater checks passed")
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
)
