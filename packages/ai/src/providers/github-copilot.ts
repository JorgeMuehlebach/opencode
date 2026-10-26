import { Headers } from "effect/http"
import type { ProviderPackage } from "../provider-package.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import type { TransportPrepareInput } from "../route/transport/index.js"
import { HttpOptions, LLMRequest, mergeJsonRecords, ProviderID, type ModelID } from "../schema/index.js"
import { GitHubCopilotResponses } from "../protocols/github-copilot-responses.js"
import { OpenAIResponses } from "../protocols/openai-responses.js"
import { OpenResponsesChannel } from "../protocols/open-responses-channel.js"
import { ProviderShared } from "../protocols/shared.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("github-copilot")

export type Config = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput & {
    readonly apiKey?: string
    readonly baseURL?: string
  }

const initiator = (request: LLMRequest) =>
  Headers.fromInput(request.http?.headers)["x-initiator"] === "agent" || request.messages.at(-1)?.role !== "user"
    ? "agent"
    : "user"

const channel = OpenResponsesChannel.transport<OpenAIResponses.OpenAIResponsesBody>({
  id: "github-copilot-responses",
  name: "GitHub Copilot Responses",
  // Initiator is per-response metadata on Copilot's WebSocket protocol.
  // Leaving it in connection headers reconnects after every tool call.
  headers: (headers) => Headers.remove(headers, "x-initiator"),
  message: (body, request) => ({ ...body, initiator: initiator(request) }),
})

const prepare = (input: TransportPrepareInput<OpenAIResponses.OpenAIResponsesBody>) => {
  const body = input.request.http?.body ? mergeJsonRecords(input.body, input.request.http.body) : input.body
  const vision =
    Array.isArray(body?.input) &&
    body.input.some((item) => {
      if (!ProviderShared.isRecord(item)) return false
      const content = item.type === "function_call_output" ? item.output : item.content
      return (
        Array.isArray(content) && content.some((part) => ProviderShared.isRecord(part) && part.type === "input_image")
      )
    })
  return channel.prepare({
    ...input,
    request: vision
      ? LLMRequest.update(input.request, {
          http: new HttpOptions({
            ...input.request.http,
            headers: Headers.set(Headers.fromInput(input.request.http?.headers), "copilot-vision-request", "true"),
          }),
        })
      : input.request,
  })
}

const route = Route.make({
  id: "github-copilot-responses",
  provider: id,
  providerMetadataKey: "copilot",
  protocol: GitHubCopilotResponses.protocol,
  endpoint: Endpoint.path("/responses", { baseURL: "https://api.githubcopilot.com" }),
  headers: ({ request }) => ({
    "openai-intent": "conversation-edits",
    "x-github-api-version": "2026-08-01",
    "x-initiator": initiator(request),
  }),
  transport: { ...channel, prepare },
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export const routes = [route]

export const configure = (input: Config = {}) => {
  const { apiKey: _apiKey, auth: _auth, baseURL, ...rest } = input
  const configured = route.with({
    ...rest,
    endpoint: { baseURL },
    auth: AuthOptions.bearer(input, []),
  })
  const responses = (modelID: string | ModelID) => configured.model<OpenAIProviderOptionsInput>({ id: modelID })
  return { id, model: responses, responses, configure }
}

export const provider = configure()
export const responses = provider.responses
export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  { apiKey, baseURL, body, headers, ...providerOptions },
) =>
  configure({
    apiKey,
    baseURL,
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).responses(modelID)

export * as GitHubCopilot from "./github-copilot.js"
