import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { AISDK } from "@opencode/core/aisdk"
import { Credential } from "@opencode/core/credential"
import { CopilotModels } from "@opencode/core/github-copilot/models"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { GithubCopilotPlugin } from "@opencode/core/plugin/provider/github-copilot"
import { Effect, Layer, Schema, Struct } from "effect"
import { testEffect } from "../lib/effect"
import { makeWebSocketServer } from "../lib/websocket-server"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decodeBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected native HTTP request") }),
    ),
  ),
)

const response = (index: number) => [
  { type: "response.created", response: { id: `resp_${index}`, created_at: 1, model: "fixture" } },
  { type: "response.output_text.delta", item_id: `msg_${index}`, delta: `Reply ${index}` },
  {
    type: "response.completed",
    response: { id: `resp_${index}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
  },
]

describe("Copilot catalog to SDK WebSocket bridge", () => {
  for (const mode of ["websocket", "rejected", "http", "https-only"] as const) {
    it.live(`uses ${mode} policy without changing transport`, () =>
      Effect.gen(function* () {
        const bodies: Array<Record<string, unknown>> = []
        const httpHeaders: Array<Record<string, string>> = []
        const server = yield* makeWebSocketServer({
          upgrade: () => mode !== "rejected",
          http: async (request) => {
            if (new URL(request.url).pathname === "/models")
              return Response.json({
                data: [
                  {
                    id: "gpt-6.1-sol",
                    name: "Sol",
                    version: "2026-10-01",
                    model_picker_enabled: true,
                    supported_endpoints: mode === "https-only" ? ["/responses"] : ["/responses", "ws:/responses"],
                    capabilities: {
                      family: "gpt",
                      limits: { max_prompt_tokens: 200000, max_output_tokens: 32000 },
                      supports: { tool_calls: true },
                    },
                  },
                ],
              })
            httpHeaders.push(Object.fromEntries(request.headers))
            bodies.push(decodeBody(await request.json()))
            return new Response(
              response(bodies.length)
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          },
          message: (socket, message) => {
            bodies.push(decodeBody(JSON.parse(message.toString())))
            response(bodies.length).forEach((event) => socket.send(JSON.stringify(event)))
          },
        })
        const baseURL = server.url.replace(/^ws/, "http").replace(/\/responses$/, "")
        const models = yield* Effect.promise(() => CopilotModels.get(baseURL, {}, []))
        const info = models.get(Model.ID.make("gpt-6.1-sol"))
        if (!info) throw new Error("Expected advertised Copilot model")
        const plugin = yield* Plugin.Service
        const host = yield* PluginHost.make(plugin)
        yield* GithubCopilotPlugin.effect(host)
        const aisdk = yield* AISDK.Service
        const model = yield* ModelResolver.fromCatalogModel(
          // No cached WebSocket capability flag: the policy still applies if discovery was unavailable.
          {
            ...info,
            settings: {
              ...(mode === "https-only" ? info.settings : Struct.omit(info.settings ?? {}, ["websocket"])),
              ...(mode === "http" ? { transport: "http" } : {}),
            },
          },
          Credential.OAuth.make({
            type: "oauth",
            methodID: Integration.MethodID.make("device"),
            access: "fixture-copilot-token",
            refresh: "fixture-copilot-token",
            expires: 0,
          }),
          { loadAISDK: (model) => aisdk.model(model) },
        )
        const llm = yield* LLMClient.Service
        if (mode === "rejected") {
          const first = yield* llm.generate(LLM.request({ model, prompt: "First" })).pipe(Effect.flip)
          const second = yield* llm.generate(LLM.request({ model, prompt: "Second" })).pipe(Effect.flip)
          expect(first.message).toContain("WebSocket")
          expect(second.message).toContain("WebSocket")
          expect(httpHeaders).toHaveLength(0)
          expect(bodies).toHaveLength(0)
          expect(server.state.headers.filter((headers) => headers.upgrade === "websocket")).toHaveLength(2)
          return
        }
        const first = yield* llm.generate(LLM.request({ model, prompt: "First" }))
        const second = yield* llm.generate(
          LLM.request({ model, messages: [Message.user("First"), first.message, Message.user("Second")] }),
        )
        expect(first.text).toBe("Reply 1")
        expect(second.text).toBe("Reply 2")
        expect(model.route.providerMetadataKey).toBe("copilot")
        const handshakes = server.state.headers.filter((headers) => headers.upgrade === "websocket")
        if (mode === "websocket") {
          expect(handshakes).toHaveLength(2)
          expect(handshakes.every((headers) => headers.authorization === "Bearer fixture-copilot-token")).toBe(true)
          expect(handshakes[0]?.["x-github-api-version"]).toBe("2026-08-01")
          expect(server.state.opens).toBe(2)
          expect(httpHeaders).toHaveLength(0)
          expect(bodies[1]).toMatchObject({ type: "response.create", initiator: "user", store: false })
          expect(bodies[1]?.stream).toBeUndefined()
        }
        if (mode === "http" || mode === "https-only") {
          expect(handshakes).toHaveLength(0)
          expect(httpHeaders).toHaveLength(2)
          expect(httpHeaders.every((headers) => headers.authorization === "Bearer fixture-copilot-token")).toBe(true)
          expect(bodies[1]?.stream).toBe(true)
        }
        expect(bodies[1]?.previous_response_id).toBeUndefined()
        expect(bodies[1]?.input).toHaveLength(3)
      }).pipe(Effect.provide(client)),
    )
  }
})
