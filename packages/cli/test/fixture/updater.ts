import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { spyOn } from "bun:test"
import { Effect, FileSystem, Layer, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import path from "node:path"
import { Updater } from "../../src/services/updater"

export function fixture(
  respond: (command: ChildProcess.StandardCommand) => Partial<AppProcess.RunResult> & {
    error?: AppProcess.AppProcessError
  } = () => ({}),
  name = "@opencode/cli",
  failCleanup = false,
  releasePackage = name,
  formula?: string,
  executableOverride?: (
    root: string,
    home: string,
  ) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem>,
  response?: () => Response,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-updater-" })
    const execPath = process.execPath
    const modules = path.join(root, "node_modules")
    const executable = executableOverride
      ? yield* executableOverride(root, path.join(root, "home"))
      : formula
        ? path.join(root, "Cellar", formula, "2.0.20", "bin", "opencode")
        : path.join(modules, "@opencode", "cli", "bin", "opencode")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "binary")
    if (!formula && !executableOverride)
      yield* fs.writeFileString(
        path.join(modules, "@opencode", "cli", "package.json"),
        JSON.stringify({ name, bin: { opencode: "bin/opencode" } }),
      )
    const requests: string[] = []
    // The updater uses global fetch; scope this replacement to each install test.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (input: string | URL | Request) => {
              const url = input instanceof Request ? input.url : input.toString()
              requests.push(url)
              if (response) return response()
              if (new URL(url).hostname === "formulae.brew.sh") return Response.json({ versions: { stable: "2.0.21" } })
              return Response.json({ version: "2.3.4", metadata: { package: releasePackage } })
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
      (request) => Effect.sync(() => request.mockRestore()),
    )
    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })
    // Windows locates the installer's Git Bash through `git --exec-path`; answer it with a fixture install.
    const git = path.join(root, "Git")
    const bash = process.platform === "win32" ? path.join(git, "bin", "bash.exe") : "bash"
    if (process.platform === "win32") {
      yield* fs.makeDirectory(path.dirname(bash), { recursive: true })
      yield* fs.writeFileString(bash, "bash")
    }
    const commands: string[][] = []
    const updater = yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        remove: (target, options) =>
          failCleanup && target.startsWith(global.cache)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                }),
              )
            : fs.remove(target, options),
        realPath: (input) => (input === execPath ? fs.realPath(executable) : fs.realPath(input)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command) =>
            Effect.suspend(() => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected piped install command")
              const lookup = command.command === "git" && command.args[0] === "--exec-path"
              if (!lookup) commands.push([command.command, ...command.args])
              const result = lookup
                ? { stdout: Buffer.from(`${path.join(git, "mingw64", "libexec", "git-core")}\n`) }
                : respond(command)
              if (result.error) return Effect.fail(result.error)
              return Effect.succeed({
                command: command.command,
                exitCode: 0,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
                ...result,
              })
            }),
          runStream: () => Stream.die("Unexpected streaming install command"),
        }),
      ),
    )
    return { updater, commands, requests, global, fs, executable, bash }
  })
}
