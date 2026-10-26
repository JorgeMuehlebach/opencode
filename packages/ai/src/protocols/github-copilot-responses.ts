import { Effect } from "effect"
import { Protocol } from "../route/protocol.js"
import type { AIError, LLMEvent, LLMRequest } from "../schema/index.js"
import { OpenAIResponses } from "./openai-responses.js"
import { OpenResponses } from "./open-responses.js"

// Copilot can rotate item IDs within one output slot. Keep one parser identity
// while retaining the final wire identity in metadata for encrypted replay.
interface ParserState extends OpenResponses.ParserState {
  readonly itemIDs: Readonly<Record<string, string>>
}

type InputItem = OpenAIResponses.OpenAIResponsesBody["input"][number]
const replayItem = (
  item: InputItem,
): item is Extract<
  InputItem,
  { readonly type: "function_call" } | { readonly type: "message"; readonly role: "assistant" }
> => item.type === "function_call" || (item.type === "message" && item.role === "assistant")

const step = Effect.fnUntraced(function* (
  state: ParserState,
  event: OpenResponses.Event,
): Effect.fn.Return<readonly [ParserState, ReadonlyArray<LLMEvent>], AIError> {
  const wireID = event.item?.id
  const slot = event.output_index === undefined ? undefined : state.outputItems[event.output_index]
  const itemID = slot ?? (wireID === undefined ? undefined : (state.itemIDs[wireID] ?? wireID))
  const itemIDs = wireID && itemID ? { ...state.itemIDs, [wireID]: itemID } : state.itemIDs
  const active =
    event.output_index === undefined
      ? event.type.startsWith("response.reasoning")
        ? Object.keys(state.reasoningItems).at(-1)
        : event.type.startsWith("response.output_text")
          ? state.message?.id
          : undefined
      : undefined
  const deltaID = event.item_id === undefined ? undefined : (itemIDs[event.item_id] ?? active ?? event.item_id)
  const [next, events] = yield* OpenAIResponses.protocol.stream.step(state, {
    ...event,
    item: event.item && itemID ? { ...event.item, id: itemID } : event.item,
    item_id: deltaID,
  })
  return [
    { ...next, itemIDs },
    wireID && itemID && event.type === "response.output_item.done"
      ? events.map((event) =>
          "providerMetadata" in event && event.providerMetadata?.copilot?.itemId === itemID
            ? {
                ...event,
                providerMetadata: {
                  ...event.providerMetadata,
                  copilot: { ...event.providerMetadata.copilot, itemId: wireID },
                },
              }
            : event,
        )
      : events,
  ] as const
})

export const protocol = Protocol.make({
  ...OpenAIResponses.protocol,
  body: {
    schema: OpenAIResponses.protocol.body.schema,
    from: Effect.fn("GitHubCopilotResponses.fromRequest")(function* (request: LLMRequest) {
      const body = yield* OpenAIResponses.protocol.body.from(request)
      if (body.store !== false) return body
      return {
        ...body,
        input: body.input.flatMap<OpenAIResponses.OpenAIResponsesBody["input"][number]>((item) => {
          if (item.type === "reasoning") return item.id && item.encrypted_content ? [{ ...item, summary: [] }] : []
          if (replayItem(item)) {
            const { id: _id, ...rest } = item
            return [rest]
          }
          return [item]
        }),
      }
    }),
  },
  stream: {
    ...OpenAIResponses.protocol.stream,
    initial: (request): ParserState => ({ ...OpenAIResponses.protocol.stream.initial(request), itemIDs: {} }),
    step,
  },
})

export * as GitHubCopilotResponses from "./github-copilot-responses.js"
