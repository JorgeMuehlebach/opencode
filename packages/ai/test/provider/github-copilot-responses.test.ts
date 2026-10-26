import { NodeSocket } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Socket } from "effect/socket"
import { LLM, LLMRequest, Media, Message } from "../../src/effect.js"
import { GitHubCopilot } from "../../src/providers/github-copilot.js"
import { OpenAIResponses } from "../../src/protocols/openai-responses.js"
import { decodeJson, encodeJson } from "../../src/protocols/shared.js"
import {
  LLMClient,
  WebSocketTransport,
  type ChannelCheckpoint,
  type ChannelObservation,
  type WebSocketChannelDriver,
  type WebSocketChannelExecutor,
  type WebSocketConnection,
} from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, fixedResponse, runtimeLayer } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = GitHubCopilot.model("gpt-6.1", { apiKey: "fixture" })

const frame = (observation: ChannelObservation) =>
  "error" in observation ? Effect.fail(observation.error) : Effect.succeed(observation.frame)

const makeChannel = Effect.gen(function* () {
  const constructor = yield* Socket.WebSocketConstructor
  let connection: WebSocketConnection | undefined
  let checkpoint: ChannelCheckpoint | undefined
  let pending: ChannelCheckpoint | undefined
  yield* Effect.addFinalizer(() => connection?.close ?? Effect.void)
  const modes: string[] = []
  const connectHeaders: string[] = []
  const executor: WebSocketChannelExecutor = {
    execute: (exchange) =>
      Effect.gen(function* () {
        connectHeaders.push(encodeJson(exchange.connect.headers))
        connection ??= yield* WebSocketTransport.open(exchange.connect).pipe(
          Effect.provideService(Socket.WebSocketConstructor, constructor),
        )
        const create = yield* exchange.driver.create(checkpoint)
        modes.push(create.mode)
        pending = undefined
        yield* connection.sendText(create.message)
        const decoder = new TextDecoder()
        return {
          frames: connection.messages.pipe(
            Stream.map((message) => WebSocketTransport.messageText(message, decoder)),
            Stream.mapEffect((message) => exchange.driver.observe(create, message)),
            Stream.tap((observation) =>
              Effect.sync(() => {
                if (observation.type === "completed") pending = observation.checkpoint
              }),
            ),
            Stream.takeUntil((observation) => observation.type !== "frame"),
            Stream.mapEffect(frame),
          ),
          complete: Effect.sync(() => {
            checkpoint = pending
          }),
        }
      }),
  }
  return { executor, modes, connectHeaders }
})

const channelDriver = (request: LLMRequest) =>
  Effect.gen(function* () {
    let driver: WebSocketChannelDriver | undefined
    yield* LLMClient.generate(request, {
      webSocket: {
        execute: (exchange) =>
          Effect.sync(() => {
            driver = exchange.driver
            return { frames: exchange.fallback(), complete: Effect.void }
          }),
      },
    }).pipe(Effect.provide(fixedResponse(sseEvents({ type: "response.completed", response: { id: "http" } }))))
    if (!driver) return yield* Effect.die("Expected WebSocket driver")
    return driver
  })

const completed = (driver: WebSocketChannelDriver, output: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const create = yield* driver.create(undefined)
    yield* driver.observe(create, encodeJson({ type: "response.created", response: { id: "resp_1" } }))
    const observation = yield* driver.observe(
      create,
      encodeJson({ type: "response.completed", response: { id: "resp_1", output } }),
    )
    if (observation.type !== "completed" || !observation.checkpoint) return yield* Effect.die("Expected checkpoint")
    return observation.checkpoint
  })

describe("GitHub Copilot native Responses", () => {
  it.effect("maps flat provider settings and preserves stateless Copilot replay", () =>
    Effect.gen(function* () {
      const selected = GitHubCopilot.model("gpt-6.1", {
        apiKey: "fixture",
        baseURL: "https://copilot.example",
        headers: { "x-application": "opencode" },
        body: { extension: true },
        reasoningEffort: "high",
      })
      const prepared = yield* compileRequest(
        LLM.request({
          model: selected,
          messages: [
            Message.user("Hello"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Private summary",
                providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } },
              },
              { type: "reasoning", text: "Unreplayable", providerMetadata: { copilot: { itemId: "rs_2" } } },
              { type: "text", text: "Thinking", providerMetadata: { copilot: { itemId: "msg_1" } } },
              {
                type: "tool-call",
                id: "call_1",
                name: "lookup",
                input: {},
                providerMetadata: { copilot: { itemId: "fc_1" } },
              },
            ]),
            Message.tool({ id: "call_1", name: "lookup", result: "42", resultType: "text" }),
          ],
        }),
      )
      expect(selected.provider).toBe("github-copilot")
      expect(selected.route.providerMetadataKey).toBe("copilot")
      expect(selected.route.endpoint.baseURL).toBe("https://copilot.example")
      expect(selected.route.defaults.http?.body).toEqual({ extension: true })
      expect(prepared.body).toMatchObject({
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "high" },
      })
      expect(prepared.body.input).toEqual([
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
        { type: "reasoning", id: "rs_1", encrypted_content: "encrypted", summary: [] },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Thinking" }],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "42" },
      ])
    }),
  )

  it.live("streams text over a local HTTP endpoint with Copilot headers and explicit HTTP semantics", () =>
    Effect.gen(function* () {
      const calls: Request[] = []
      const bodies: unknown[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              calls.push(request)
              bodies.push(await request.json())
              return new Response(
                sseEvents(
                  {
                    type: "response.output_item.done",
                    item: { type: "message", id: "msg_http", content: [{ type: "output_text", text: "HTTP works" }] },
                  },
                  { type: "response.completed", response: { id: "resp_http" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: GitHubCopilot.model("gpt-6.1", {
            apiKey: "fixture",
            baseURL: server.url.toString(),
            headers: { "x-interaction-id": "interaction" },
          }),
          messages: [Message.user({ type: "media", media: Media.base64("AAECAw==", "image/png") })],
        }),
      ).pipe(Effect.provide(runtimeLayer(FetchHttpClient.layer)))
      yield* LLMClient.generate(
        LLM.request({
          model: GitHubCopilot.model("gpt-6.1", { apiKey: "fixture", baseURL: server.url.toString() }),
          messages: [
            Message.user("Read the screenshot"),
            Message.assistant({ type: "tool-call", id: "call_1", name: "read", input: {} }),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
        }),
      ).pipe(Effect.provide(runtimeLayer(FetchHttpClient.layer)))
      expect(response.text).toBe("HTTP works")
      expect(calls).toHaveLength(2)
      expect(new URL(calls[0].url).pathname).toBe("/responses")
      expect(calls[0].headers.get("authorization")).toBe("Bearer fixture")
      expect(calls[0].headers.get("openai-intent")).toBe("conversation-edits")
      expect(calls[0].headers.get("x-github-api-version")).toBe("2026-08-01")
      expect(calls[0].headers.get("x-initiator")).toBe("user")
      expect(calls[0].headers.get("copilot-vision-request")).toBe("true")
      expect(calls[1].headers.get("copilot-vision-request")).toBe("true")
      expect(calls[1].headers.get("x-initiator")).toBe("agent")
      expect(bodies[0]).toMatchObject({ stream: true, store: false })
      expect(bodies[0]).toMatchObject({ input: [{ content: [{ type: "input_image" }] }] })
      expect(bodies[1]).toMatchObject({
        input: [
          { role: "user" },
          { type: "function_call" },
          { type: "function_call_output", output: [{ type: "input_image" }] },
        ],
      })
      expect(bodies[0]).not.toHaveProperty("initiator")
      expect(response.message.content[0]).toMatchObject({ providerMetadata: { copilot: { itemId: "msg_http" } } })
    }),
  )

  it.live("continues a reasoning/tool exchange and user follow-up over one authenticated WebSocket", () =>
    Effect.gen(function* () {
      const headers: Headers[] = []
      const sent: unknown[] = []
      const text = "Large response. ".repeat(20_000)
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request, server) {
              headers.push(request.headers)
              if (server.upgrade(request, { data: undefined })) return undefined
              return new Response("Unexpected HTTP", { status: 500 })
            },
            websocket: {
              message(socket, message) {
                sent.push(decodeJson(message.toString()))
                const id = `resp_${sent.length}`
                socket.send(encodeJson({ type: "response.created", response: { id } }))
                const output =
                  sent.length === 1
                    ? [
                        {
                          type: "reasoning",
                          id: "rs_done",
                          summary: [{ type: "summary_text", text: "Check" }],
                          encrypted_content: "encrypted",
                        },
                        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
                      ]
                    : [
                        {
                          type: "message",
                          id: `msg_${sent.length}`,
                          role: "assistant",
                          content: [{ type: "output_text", text }],
                        },
                      ]
                output.forEach((item, output_index) =>
                  socket.send(encodeJson({ type: "response.output_item.done", output_index, item })),
                )
                const completed = output.map((item) =>
                  item.type === "reasoning" ? { ...item, id: "rs_complete", encrypted_content: "reencrypted" } : item,
                )
                socket.send(encodeJson({ type: "response.completed", response: { id, output: completed } }))
              },
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const channel = yield* makeChannel
      const request = LLM.request({
        model: GitHubCopilot.model("gpt-6.1", {
          apiKey: "fixture",
          baseURL: server.url.toString(),
          headers: { "x-interaction-id": "interaction" },
        }),
        messages: [
          Message.user([
            { type: "text", text: "Look it up" },
            { type: "media", media: Media.base64("AAECAw==", "image/png") },
          ]),
        ],
        tools: [{ name: "lookup", description: "Look up a number", inputSchema: { type: "object", properties: {} } }],
      })
      const first = yield* LLMClient.generate(request, { webSocket: channel.executor })
      const secondRequest = LLMRequest.update(request, {
        messages: [
          ...request.messages,
          first.message,
          Message.tool({ id: "call_1", name: "lookup", result: "42", resultType: "text" }),
        ],
      })
      const second = yield* LLMClient.generate(secondRequest, { webSocket: channel.executor })
      const third = yield* LLMClient.generate(
        LLMRequest.update(request, { messages: [...secondRequest.messages, second.message, Message.user("Continue")] }),
        { webSocket: channel.executor },
      )
      expect(first.toolCalls[0]).toMatchObject({ id: "call_1", name: "lookup" })
      expect(first.message.content[0]).toMatchObject({
        providerMetadata: { copilot: { itemId: "rs_done", reasoningEncryptedContent: "encrypted" } },
      })
      expect(second.text).toBe(text)
      expect(third.text).toBe(text)
      expect(headers).toHaveLength(1)
      expect(headers[0].get("authorization")).toBe("Bearer fixture")
      expect(headers[0].get("x-initiator")).toBeNull()
      expect(headers[0].get("copilot-vision-request")).toBe("true")
      expect(headers[0].get("x-interaction-id")).toBe("interaction")
      expect(channel.modes).toEqual(["full", "incremental", "incremental"])
      expect(new Set(channel.connectHeaders).size).toBe(1)
      expect(sent[0]).toMatchObject({ type: "response.create", initiator: "user" })
      expect(sent[0]).not.toHaveProperty("stream")
      expect(sent[1]).toMatchObject({
        initiator: "agent",
        previous_response_id: "resp_1",
        input: [{ type: "function_call_output", call_id: "call_1", output: "42" }],
      })
      expect(sent[2]).toMatchObject({
        initiator: "user",
        previous_response_id: "resp_2",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
      })
    }).pipe(
      Effect.provide(runtimeLayer(FetchHttpClient.layer)),
      Effect.provide(NodeSocket.layerWebSocketConstructorWS),
      Effect.timeout("10 seconds"),
    ),
  )

  it.effect("keeps explicit agent initiators and falls back through the original HTTP route", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.request({
          model: GitHubCopilot.model("gpt-6.1", { apiKey: "fixture", headers: { "X-Initiator": "agent" } }),
          prompt: "Subagent input",
        }),
        {
          webSocket: {
            execute: (exchange) =>
              Effect.gen(function* () {
                const create = yield* exchange.driver.create(undefined)
                expect(decodeJson(create.message)).toMatchObject({ initiator: "agent" })
                expect(exchange.connect.headers["x-initiator"]).toBeUndefined()
                return { frames: exchange.fallback(), complete: Effect.void }
              }),
          },
        },
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.sync(() => {
              expect(input.request.headers["x-initiator"]).toBe("agent")
              expect(decodeJson(input.text)).not.toHaveProperty("initiator")
              return input.respond(sseEvents({ type: "response.completed", response: { id: "fallback" } }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("normalizes rotating reasoning IDs while preserving final Copilot replay metadata", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Think" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
              {
                type: "response.reasoning_summary_text.delta",
                item_id: "rs_rotated",
                summary_index: 0,
                delta: "Checked",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "reasoning", id: "rs_final", encrypted_content: "encrypted" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      expect(response.reasoning).toBe("Checked")
      expect(response.message.content[0]).toMatchObject({
        providerMetadata: { copilot: { itemId: "rs_final", reasoningEncryptedContent: "encrypted" } },
      })
      const replay = yield* compileRequest(
        LLM.request({ model, messages: [response.message, Message.user("Continue")] }),
      )
      expect(replay.body.input[0]).toEqual({
        type: "reasoning",
        id: "rs_final",
        encrypted_content: "encrypted",
        summary: [],
      })
    }),
  )

  it.effect("keeps nested WebSocket errors actionable", () =>
    Effect.gen(function* () {
      const driver = yield* channelDriver(LLM.request({ model, prompt: "Hello" }))
      const create = yield* driver.create(undefined)
      const observation = yield* driver.observe(
        create,
        encodeJson({
          type: "error",
          status: 400,
          error: { code: "context_length_exceeded", message: "The context window is full" },
        }),
      )
      expect(observation.type).toBe("provider-failure")
      if (observation.type !== "provider-failure") return yield* Effect.die("Expected provider failure")
      expect(observation.error.message).toContain("The context window is full")
      expect(observation.error.reason).toMatchObject({ _tag: "InvalidRequest", classification: "context-overflow" })
    }),
  )

  it.effect("keeps indexless text deltas on their original slot when IDs rotate", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
              { type: "response.output_text.delta", item_id: "msg_rotated", delta: "Hello" },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "message", id: "msg_final", content: [{ type: "output_text", text: "Hello" }] },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      expect(response.text).toBe("Hello")
      expect(response.message.content).toHaveLength(1)
      expect(response.message.content[0]).toMatchObject({
        text: "Hello",
        providerMetadata: { copilot: { itemId: "msg_final" } },
      })
    }),
  )

  it.effect("keeps streamed tool arguments attached to their output slot when IDs rotate", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Look up 42" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "function_call", id: "fc_rotated", call_id: "call_1", name: "lookup", arguments: "" },
              },
              { type: "response.function_call_arguments.delta", item_id: "fc_rotated", delta: '{"id":' },
              { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "42}" },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_final",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: '{"id":42}',
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      expect(response.toolCalls).toHaveLength(1)
      expect(response.toolCalls[0]).toMatchObject({
        id: "call_1",
        name: "lookup",
        input: { id: 42 },
        providerMetadata: { copilot: { itemId: "fc_final" } },
      })
    }),
  )

  it.effect("compares encrypted reasoning state independently of summary representation", () =>
    Effect.gen(function* () {
      const prior = yield* channelDriver(LLM.request({ model, prompt: "Hello" }))
      const checkpoint = yield* completed(prior, [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "encrypted",
          summary: [{ type: "summary_text", text: "Original summary" }],
        },
      ])
      const next = (encrypted: string) =>
        channelDriver(
          LLM.request({
            model,
            messages: [
              Message.user("Hello"),
              Message.assistant({
                type: "reasoning",
                text: "Different summary",
                providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: encrypted } },
              }),
              Message.user("Continue"),
            ],
          }),
        )
      const same = yield* (yield* next("encrypted")).create(checkpoint)
      const different = yield* (yield* next("changed")).create(checkpoint)
      expect(same.mode).toBe("incremental")
      expect(different.mode).toBe("full")
      expect(decodeJson(different.message)).toMatchObject({
        input: [{ role: "user" }, { type: "reasoning", encrypted_content: "changed", summary: [] }, { role: "user" }],
      })
    }),
  )

  it.effect("continues comparing unencrypted reasoning summaries on the shared OpenAI route", () =>
    Effect.gen(function* () {
      const selected = OpenAIResponses.route.model({ id: "fixture" })
      const prior = yield* channelDriver(LLM.request({ model: selected, prompt: "Hello" }))
      const checkpoint = yield* completed(prior, [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: null,
          summary: [{ type: "summary_text", text: "Original" }],
        },
      ])
      const next = yield* channelDriver(
        LLM.request({
          model: selected,
          messages: [
            Message.user("Hello"),
            Message.assistant({ type: "reasoning", text: "Changed", providerMetadata: { openai: { itemId: "rs_1" } } }),
            Message.user("Continue"),
          ],
        }),
      )
      expect((yield* next.create(checkpoint)).mode).toBe("full")
    }),
  )
})
