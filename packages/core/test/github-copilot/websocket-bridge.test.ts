import { expect, test } from "bun:test"
import { CopilotWebSocket } from "@opencode/core/github-copilot/websocket"
import { InvalidResponseDataError } from "@ai-sdk/provider"
import { AIError } from "@opencode/ai/effect"
import { Effect } from "effect"
import { withEnv } from "../fixture/env"
import { it } from "../lib/effect"

function server(messages: string[], close = false) {
  const closed = Promise.withResolvers<void>()
  const requests: unknown[] = []
  const headers: Headers[] = []
  const instance = Bun.serve({
    port: 0,
    fetch(request, server) {
      headers.push(request.headers)
      if (server.upgrade(request)) return
      return Response.json({ ordinary: true })
    },
    websocket: {
      message(socket, message) {
        requests.push(JSON.parse(String(message)))
        messages.forEach((message) => socket.send(message))
        if (close) socket.close()
      },
      close() {
        closed.resolve()
      },
    },
  })
  return {
    instance,
    closed: closed.promise,
    requests,
    headers,
    request: (signal?: AbortSignal) =>
      CopilotWebSocket.request(`${instance.url}responses`, {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json", "x-initiator": "agent" },
        body: JSON.stringify({ model: "gpt-6.1-sol", stream: true, store: false, tools: [] }),
        signal,
      }),
  }
}

test("streams complete provider events and closes the connection", async () => {
  const fixture = server([
    '{"type":"response.output_text.delta","delta":"OK"}',
    '{"type":"response.completed","response":{"status":"completed"}}',
  ])
  try {
    const response = await fixture.request()
    expect(await response.text()).toBe(
      'data: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    )
    expect(fixture.requests).toEqual([
      {
        type: "response.create",
        model: "gpt-6.1-sol",
        store: false,
        tools: [],
        initiator: "agent",
      },
    ])
    expect(fixture.headers[0]?.get("authorization")).toBe("Bearer fixture")
    await fixture.closed
  } finally {
    await fixture.instance.stop(true)
  }
})

test.each(["response.incomplete", "response.failed", "error"])(
  "ends on %s without fabricating completion",
  async (type) => {
    const fixture = server([JSON.stringify({ type })])
    try {
      expect(await (await fixture.request()).text()).toBe(`data: ${JSON.stringify({ type })}\n\n`)
      await fixture.closed
    } finally {
      await fixture.instance.stop(true)
    }
  },
)

test("reports early socket closure as a transport error", async () => {
  const fixture = server([], true)
  try {
    await expect(fixture.request().then((response) => response.text())).rejects.toBeInstanceOf(AIError)
    await fixture.closed
  } finally {
    await fixture.instance.stop(true)
  }
})

test("reports malformed JSON as invalid provider output", async () => {
  const fixture = server(['{"type":"response.completed"'])
  try {
    await expect(fixture.request().then((response) => response.text())).rejects.toBeInstanceOf(InvalidResponseDataError)
    await fixture.closed
  } finally {
    await fixture.instance.stop(true)
  }
})

test.each(["abort", "cancel"])("%s closes the active socket", async (mode) => {
  const fixture = server([])
  const controller = new AbortController()
  try {
    const response = await fixture.request(controller.signal)
    if (mode === "abort") {
      const text = response.text()
      controller.abort()
      await expect(text).rejects.toMatchObject({ name: "AbortError" })
    }
    if (mode === "cancel") await response.body?.cancel()
    await fixture.closed
  } finally {
    await fixture.instance.stop(true)
  }
})

test.each(["responses", "chat/completions"])("never sends a non-streaming %s request over HTTP", async (endpoint) => {
  const fixture = server([])
  try {
    await expect(
      CopilotWebSocket.request(`${fixture.instance.url}${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", stream: false }),
      }),
    ).rejects.toThrow("Copilot WebSockets require")
    expect(fixture.headers).toEqual([])
  } finally {
    await fixture.instance.stop(true)
  }
})

test("preserves a burst of events and a large terminal snapshot", async () => {
  const events = Array.from({ length: 2000 }, () => '{"type":"response.output_text.delta","delta":"x"}')
  const completed = JSON.stringify({
    type: "response.completed",
    response: { output: [], metadata: "x".repeat(2 ** 21) },
  })
  const fixture = server([...events, completed])
  try {
    const body = await (await fixture.request()).text()
    expect(body).toBe([...events, completed].map((event) => `data: ${event}\n\n`).join(""))
    await fixture.closed
  } finally {
    await fixture.instance.stop(true)
  }
})

it.live("uses the configured proxy for the WebSocket handshake", () =>
  Effect.gen(function* () {
    const methods: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        methods.push(request.method)
        return new Response("Fixture refuses the tunnel", { status: 502 })
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => proxy.stop(true)))
    yield* withEnv({ WS_PROXY: proxy.url.origin, NO_PROXY: undefined, no_proxy: undefined }, () =>
      Effect.promise(async () => {
        await expect(
          CopilotWebSocket.request("http://192.0.2.1:9/responses", {
            method: "POST",
            body: JSON.stringify({ model: "fixture", stream: true }),
            signal: AbortSignal.timeout(5000),
          }),
        ).rejects.toBeDefined()
        expect(methods).toEqual(["CONNECT"])
      }),
    )
  }),
)
