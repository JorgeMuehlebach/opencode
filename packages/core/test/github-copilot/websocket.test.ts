import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor, WebSocketTransport } from "@opencode/ai/route"
import { Credential } from "@opencode/core/credential"
import { WebSocketConstructor } from "@opencode/core/effect/websocket-constructor"
import { CopilotModels } from "@opencode/core/github-copilot/models"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { Session } from "@opencode/schema/session"
import { Effect, Layer, Schema } from "effect"
import { Socket } from "effect/socket"
import { it } from "../lib/effect"
import { makeWebSocketServer } from "../lib/websocket-server"

const response = (index: number) => {
  const item = {
    type: "message",
    id: `msg_${index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: `Reply ${index}`, annotations: [] }],
  }
  return [
    { type: "response.created", response: { id: `resp_${index}` } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, delta: `Reply ${index}` },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, text: `Reply ${index}` },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${index}`, output: [item] } },
  ]
}

describe("Copilot catalog to session transport", () => {
  for (const upgrade of [true, false]) {
    it.live(
      upgrade
        ? "continues the advertised WebSocket route"
        : "falls back to authenticated HTTP after a rejected upgrade",
      () =>
        Effect.gen(function* () {
          const bodies: Array<Record<string, unknown>> = []
          const httpHeaders: Array<Record<string, string>> = []
          const server = yield* makeWebSocketServer({
            upgrade: () => upgrade,
            http: async (request) => {
              if (new URL(request.url).pathname === "/models")
                return Response.json({
                  data: [
                    {
                      id: "gpt-6.1-sol",
                      name: "Sol",
                      version: "2026-10-01",
                      model_picker_enabled: true,
                      supported_endpoints: ["/responses", "ws:/responses"],
                      capabilities: {
                        family: "gpt",
                        limits: { max_prompt_tokens: 200000, max_output_tokens: 32000 },
                        supports: { tool_calls: true },
                      },
                    },
                  ],
                })
              httpHeaders.push(Object.fromEntries(request.headers))
              bodies.push(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()))
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
              bodies.push(JSON.parse(message.toString()))
              response(bodies.length).forEach((event) => socket.send(JSON.stringify(event)))
            },
          })
          const baseURL = server.url.replace(/^ws/, "http").replace(/\/responses$/, "")
          const models = yield* Effect.promise(() => CopilotModels.get(baseURL, {}, []))
          const info = models.get(Model.ID.make("gpt-6.1-sol"))
          if (!info) throw new Error("Expected advertised Copilot model")
          const model = yield* ModelResolver.fromCatalogModel(
            info,
            Credential.OAuth.make({
              type: "oauth",
              methodID: Integration.MethodID.make("device"),
              access: "fixture-copilot-token",
              refresh: "fixture-copilot-token",
              expires: 0,
            }),
          )
          const transport = yield* SessionModelTransport.Service
          const options = { webSocket: transport.bind(Session.ID.make("ses_copilot_socket")) }
          const llm = yield* LLMClient.Service
          const first = yield* llm.generate(LLM.request({ model, prompt: "First" }), options)
          const second = yield* llm.generate(
            LLM.request({
              model,
              messages: [Message.user("First"), first.message, Message.user("Second")],
            }),
            options,
          )

          expect(first.text).toBe("Reply 1")
          expect(second.text).toBe("Reply 2")
          expect(model.route.providerMetadataKey).toBe("copilot")
          const handshakes = server.state.headers.filter((headers) => headers.upgrade === "websocket")
          expect(handshakes).toHaveLength(1)
          expect(handshakes[0]?.authorization).toBe("Bearer fixture-copilot-token")
          expect(handshakes[0]?.["x-github-api-version"]).toBe("2026-08-01")
          if (upgrade) {
            expect(server.state.opens).toBe(1)
            expect(httpHeaders).toHaveLength(0)
            expect(bodies[1]).toMatchObject({
              type: "response.create",
              initiator: "user",
              previous_response_id: "resp_1",
              input: [{ role: "user", content: [{ type: "input_text", text: "Second" }] }],
            })
            return
          }
          expect(server.state.opens).toBe(0)
          expect(httpHeaders).toHaveLength(2)
          expect(httpHeaders.every((headers) => headers.authorization === "Bearer fixture-copilot-token")).toBe(true)
          expect(httpHeaders.every((headers) => headers["x-initiator"] === "user")).toBe(true)
          expect(bodies[1]?.previous_response_id).toBeUndefined()
          expect(bodies[1]?.input).toHaveLength(3)
        }).pipe(
          Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
          Effect.provide(
            Layer.unwrap(
              Effect.gen(function* () {
                const constructor = yield* Socket.WebSocketConstructor
                return SessionModelTransport.makeLayer({
                  open: (input) =>
                    WebSocketTransport.open(input).pipe(
                      Effect.provideService(Socket.WebSocketConstructor, constructor),
                    ),
                })
              }),
            ),
          ),
          Effect.provide(WebSocketConstructor.layer),
        ),
    )
  }
})
