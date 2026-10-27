import { APICallError, InvalidResponseDataError } from "@ai-sdk/provider"
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { RequestExecutor } from "@opencode/ai/route"
import { convertToOpenAIResponsesInput } from "@opencode/core/github-copilot/responses/convert-to-openai-responses-input"
import { OpenAIResponsesLanguageModel } from "@opencode/core/github-copilot/responses/openai-responses-language-model"
import { expect, test } from "bun:test"

const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]
const usage = { input_tokens: 12, output_tokens: 3 }

async function stream(events: ReadonlyArray<Record<string, unknown>>) {
  const model = new OpenAIResponsesLanguageModel("test-model", {
    provider: "copilot",
    url: () => "https://copilot.example/responses",
    headers: () => ({ Authorization: "Bearer fixture-token" }),
    fetch: Object.assign(
      async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      { preconnect() {} },
    ),
  })
  const result = await model.doStream({ prompt })
  const reader = result.stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  while (true) {
    const item = await reader.read()
    if (item.done) return parts
    parts.push(item.value)
  }
}

async function replay(parts: ReadonlyArray<LanguageModelV3StreamPart>) {
  return convertToOpenAIResponsesInput({
    prompt: [
      {
        role: "assistant",
        content: parts
          .filter((part) => part.type === "reasoning-end")
          .map((part) => ({ type: "reasoning", text: "", providerOptions: part.providerMetadata })),
      },
    ],
    store: false,
    systemMessageMode: "system",
  })
}

test("preserves response.failed provider error details without a misleading missing-terminal error", async () => {
  const parts = await stream([
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Partial" },
    {
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        error: { code: "rate_limit_exceeded", message: "Specific quota message", type: "rate_limit_error" },
        usage: null,
      },
    },
  ])
  const errors = parts.filter((part) => part.type === "error")
  expect(errors).toHaveLength(1)
  expect(APICallError.isInstance(errors[0].error)).toBe(true)
  expect(errors[0].error).toMatchObject({
    message: "Specific quota message",
    data: { error: { code: "rate_limit_exceeded", message: "Specific quota message", type: "rate_limit_error" } },
    isRetryable: false,
  })
  const error = errors[0].error
  if (!APICallError.isInstance(error)) throw new Error("Expected a provider API error")
  expect(
    RequestExecutor.httpFailure({ message: error.message, data: error.data, responseBody: error.responseBody }).reason
      ._tag,
  ).toBe("RateLimit")
  expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
})

test.each([
  { type: "error", code: "model_not_supported", message: "This model has no WebSocket route" },
  { type: "error", error: { code: "model_not_supported", message: "This model has no WebSocket route" } },
])("preserves a WebSocket error envelope without requiring sequence_number: %j", async (event) => {
  const parts = await stream([event])
  const errors = parts.filter((part) => part.type === "error")
  expect(errors).toHaveLength(1)
  expect(errors[0].error).toMatchObject({
    message: "This model has no WebSocket route",
    data: { error: { code: "model_not_supported" } },
  })
  expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
})

test.each([
  { type: "response.completed", response: { usage: null }, finish: "stop" },
  {
    type: "response.incomplete",
    response: { usage: null, incomplete_details: { reason: "max_output_tokens" } },
    finish: "length",
  },
])("accepts nullable usage in $type", async ({ type, response, finish }) => {
  const parts = await stream([{ type, response }])
  expect(parts.filter((part) => part.type === "error")).toHaveLength(0)
  expect(parts.at(-1)).toMatchObject({
    type: "finish",
    finishReason: { unified: finish },
    usage: { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
  })
})

test("rejects clean EOF without a terminal event instead of reporting success", async () => {
  const parts = await stream([{ type: "response.output_text.delta", item_id: "msg_1", delta: "Truncated" }])
  const errors = parts.filter((part) => part.type === "error")
  expect(errors).toHaveLength(1)
  expect(InvalidResponseDataError.isInstance(errors[0].error)).toBe(true)
  expect(errors[0].error).toMatchObject({
    message: expect.stringContaining("last event: response.output_text.delta"),
  })
  expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1)
  expect(parts.filter((part) => part.type === "finish")).toHaveLength(0)
})

test("reports a malformed known event as a validation error", async () => {
  const parts = await stream([{ type: "response.completed", response: { usage: { input_tokens: 12 } } }])
  expect(parts.filter((part) => part.type === "error")).toHaveLength(1)
  expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
})

test("ignores unknown events and preserves a successful completion", async () => {
  const parts = await stream([
    { type: "response.future_event", future: { value: true } },
    { type: "response.output_item.added", output_index: 0, item: { type: "future_item", future: true } },
    { type: "response.output_item.done", output_index: 0, item: { type: "future_item", future: true } },
    { type: "response.completed", response: { usage, output: [{ type: "future_item", future: true }] } },
  ])
  expect(parts.filter((part) => part.type === "error")).toHaveLength(0)
  expect(parts.at(-1)).toMatchObject({
    type: "finish",
    finishReason: { unified: "stop" },
    usage: { inputTokens: { total: 12 }, outputTokens: { total: 3 } },
  })
})

test("validates known output item types while ignoring future item types", async () => {
  const parts = await stream([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1" } },
  ])
  expect(parts.filter((part) => part.type === "error")).toHaveLength(1)
  expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } })
})

test.each([true, false])("replays final-snapshot encrypted reasoning with output_item.done=%s", async (done) => {
  const parts = await stream([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_start" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_rotated", summary_index: 0, delta: "Thinking" },
    { type: "response.reasoning_summary_part.done", item_id: "rs_rotated", summary_index: 0 },
    ...(done
      ? [{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_done" } }]
      : []),
    {
      type: "response.completed",
      response: {
        id: "resp_final",
        usage,
        output: [{ type: "reasoning", id: "rs_final", encrypted_content: "final-encrypted-state", summary: [] }],
      },
    },
  ])
  expect(parts.filter((part) => part.type === "reasoning-start")).toHaveLength(1)
  expect(parts.filter((part) => part.type === "reasoning-end")).toEqual([
    {
      type: "reasoning-end",
      id: "rs_start:0",
      providerMetadata: {
        copilot: {
          itemId: "rs_final",
          reasoningOriginalItemId: "rs_start",
          reasoningEncryptedContent: "final-encrypted-state",
        },
      },
    },
  ])
  expect((await replay(parts)).input).toEqual([
    { type: "reasoning", id: "rs_final", encrypted_content: "final-encrypted-state", summary: [] },
  ])
  expect(parts.at(-1)).toMatchObject({ type: "finish", providerMetadata: { copilot: { responseId: "resp_final" } } })
})

test("does not duplicate reasoning already completed with encrypted content", async () => {
  const parts = await stream([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_start" } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", id: "rs_done", encrypted_content: "done-encrypted-state" },
    },
    {
      type: "response.completed",
      response: {
        usage,
        output: [{ type: "reasoning", id: "rs_final", encrypted_content: "final-encrypted-state", summary: [] }],
      },
    },
  ])
  expect(parts.filter((part) => part.type === "reasoning-start")).toHaveLength(1)
  expect(parts.filter((part) => part.type === "reasoning-end")).toHaveLength(1)
  expect((await replay(parts)).input).toEqual([
    { type: "reasoning", id: "rs_done", encrypted_content: "done-encrypted-state", summary: [] },
  ])
})

test("preserves encrypted-only reasoning provided in the completion snapshot", async () => {
  const parts = await stream([
    {
      type: "response.completed",
      response: {
        usage,
        output: [{ type: "reasoning", id: "rs_final", encrypted_content: "encrypted-state", summary: [] }],
      },
    },
  ])
  expect(parts.filter((part) => part.type.startsWith("reasoning-"))).toEqual([
    { type: "reasoning-start", id: "rs_final:0" },
    {
      type: "reasoning-end",
      id: "rs_final:0",
      providerMetadata: { copilot: { itemId: "rs_final", reasoningEncryptedContent: "encrypted-state" } },
    },
  ])
  expect((await replay(parts)).input).toEqual([
    { type: "reasoning", id: "rs_final", encrypted_content: "encrypted-state", summary: [] },
  ])
})

test("preserves final-only encrypted states when another reasoning item has already begun", async () => {
  const parts = await stream([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_first" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_first", summary_index: 0, delta: "First" },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_first_done" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs_second" } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_second", summary_index: 0, delta: "Second" },
    { type: "response.output_item.done", output_index: 1, item: { type: "reasoning", id: "rs_second_done" } },
    {
      type: "response.completed",
      response: {
        usage,
        output: [
          { type: "reasoning", id: "rs_first_final", encrypted_content: "first-encrypted-state" },
          { type: "reasoning", id: "rs_second_final", encrypted_content: "second-encrypted-state" },
        ],
      },
    },
  ])
  let open: string | undefined
  for (const part of parts) {
    if (part.type === "reasoning-start") {
      expect(open).toBeUndefined()
      open = part.id
    }
    if (part.type === "reasoning-end") {
      expect(open).toBe(part.id)
      open = undefined
    }
  }
  expect(open).toBeUndefined()
  expect((await replay(parts)).input).toEqual([
    { type: "reasoning", id: "rs_first_final", encrypted_content: "first-encrypted-state", summary: [] },
    { type: "reasoning", id: "rs_second_final", encrypted_content: "second-encrypted-state", summary: [] },
  ])
})
