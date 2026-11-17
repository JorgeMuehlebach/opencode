import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { spyOn } from "bun:test"
import { Effect, FileSystem, Layer, PlatformError, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { Updater } from "../../src/services/updater"

export function fixture(
  respond: (command: {
    readonly command: string
    readonly args: ReadonlyArray<string>
  }) => Partial<AppProcess.RunResult> & {
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
    // npm's global layout on POSIX.
    const modules = path.join(root, "lib", "node_modules")
    const executable = executableOverride
      ? yield* executableOverride(root, path.join(root, "home"))
      : formula
        ? path.join(root, "Cellar", formula, "2.0.20", "bin", "opencode")
        : path.join(modules, ...name.split("/"), "bin", "opencode")
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "binary")
    if (!formula && !executableOverride)
      yield* fs.writeFileString(
        path.join(modules, ...name.split("/"), "package.json"),
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
    const paths: Array<string | undefined> = []
    const manifest = path.join(modules, ...name.split("/"), "package.json")
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
              const args = command.args.map(String)
              const lookup = command.command === "git" && args[0] === "--exec-path"
              if (!lookup) commands.push([command.command, ...args])
              if (!lookup) paths.push(command.options.env?.PATH?.toString())
              const result = lookup
                ? { stdout: Buffer.from(`${path.join(git, "mingw64", "libexec", "git-core")}\n`) }
                : respond({ command: command.command, args })
              if (result.error) return Effect.fail(result.error)
              // Successful installs replace the running copy, which the updater verifies afterwards.
              const installed = args.find((arg) => arg.startsWith(`${name}@`))?.slice(name.length + 1)
              if (!formula && !executableOverride && installed && (result.exitCode ?? 0) === 0)
                writeFileSync(manifest, JSON.stringify({ name, version: installed, bin: { opencode: "bin/opencode" } }))
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
    const prefix = yield* fs.realPath(root)
    // Windows keeps the npm on PATH and its default prefix.
    const prefixArgs = process.platform === "win32" ? [] : ["--prefix", prefix]
    return { updater, commands, paths, requests, global, fs, executable, bash, prefix, prefixArgs }
  })
}
