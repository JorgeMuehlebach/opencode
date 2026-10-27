# GitHub Copilot Transports and AI SDK Adapters

## Responses WebSockets

Copilot models advertising WebSocket support use WebSockets by default. The transport sends one
`response.create` request per connection and presents incoming events as SSE
inside OpenCode, preserving the existing Copilot SDK, request hooks, timeouts,
tools and stateless reasoning replay. Conversation history is sent in full;
connections and server-side continuation checkpoints are not reused.

The model catalog recognizes both `/responses` and `ws:/responses`. Responses
models use the bundled Copilot SDK bridge, including when catalog discovery is
unavailable. A rejected upgrade, interrupted stream or provider error fails the
request. It never automatically retries inference over HTTPS.

HTTPS-only models, including current Claude Anthropic Messages routes and Chat
Completions models, continue to use HTTPS. The catalog also selects HTTPS for
Responses models that do not advertise WebSocket support. This choice happens
before inference; a failed WebSocket request never falls back to HTTPS. OAuth,
account checks, model discovery and the HTTPS-only utility title endpoint also
continue to use HTTPS.

To deliberately use HTTPS, set the provider policy in `opencode.jsonc`:

```jsonc
{
  "providers": {
    "github-copilot": {
      "settings": { "transport": "http" },
    },
  },
}
```

Remove that override or set it to `"websocket"` to restore WebSockets. The older
explicit `websocket: false` model setting also opts into HTTP for SDK models.
A custom `fetch` implementation is supported for HTTPS routes. Responses models
using WebSockets require an explicit HTTP override before using custom fetch; it
cannot silently replace a failed WebSocket connection.

WebSocket connections use OpenCode's platform constructor, including `WSS_PROXY`,
`HTTPS_PROXY`, `WS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY`. Runtime trust
settings remain in effect. The SDK parser preserves structured provider errors,
accepts missing usage on terminal responses, and retains encrypted reasoning
provided only in the final completion snapshot.

### Verification

Local servers and fixture credentials cover authentication, tools, finish
reasons, large completion events, cancellation, proxy routing, reasoning replay,
and rejected upgrades with zero HTTP inference requests. From `packages/core`:

```bash
bun run test test/github-copilot test/aisdk.test.ts \
  test/plugin/provider-github-copilot.test.ts test/model-resolver.test.ts
```

For live acceptance, use an account entitled to the intended model:

1. Install a release or run `bun run dev --standalone` from the repository root.
2. Sign in with `/connect`, then choose a Responses model with `/models`.
3. Ask it to read a small project, make an edit and run a check. Send a follow-up
   to exercise replay of assistant output, tool results and reasoning.
4. Confirm a WebSocket upgrade and `response.create` frames in network diagnostics.
   SSE framing inside the SDK is an implementation detail, not an HTTPS request.
5. A blocked upgrade must produce a visible error. HTTPS-only models should
   continue working through their advertised HTTPS API.

Local protocol tests do not require a Copilot subscription. Authenticated live
inference is a separate acceptance step. WebSockets do not increase model context
windows or remove gateway message limits.

### macOS

The `Copilot macOS` and `GitHub Release` workflows run the Copilot regression tests
on native Apple Silicon and Intel runners, build the CLI with its embedded web
UI, and execute the binary. Release archives preserve executable permissions.
See [GitHub release distribution](../../../../docs/github-releases.md) for
installation and `/update` behavior.

## HTTP Adapters

This directory contains upstream-derived AI SDK implementations adapted for
GitHub Copilot. It is not a generic OpenAI-compatible provider.

## Provenance

- `chat/` is derived from the Vercel AI SDK
  `@ai-sdk/openai-compatible` chat implementation.
- `responses/` is derived from the Vercel AI SDK `@ai-sdk/openai` Responses
  implementation.
- The exact upstream revisions originally copied into this repository are
  unknown. Current dependency versions and the `VERSION` constant in
  `copilot-provider.ts` are not copy provenance.

## Ownership

Keep `chat/` and `responses/` structurally close to their upstream modules, but
preserve the intentional Copilot adaptations: the `copilot` options and metadata
namespace, `thinking_budget`, reasoning text and opaque reasoning, stateless
Responses requests with encrypted reasoning, rotating response item IDs, and
explicit function-tool strictness taking precedence over the global fallback.

`copilot-provider.ts` is the local adapter assembly entrypoint used by
`plugin/provider/github-copilot.ts`. `models.ts` is OpenCode-owned catalog
reconciliation, not vendored SDK code. Authentication, request headers, model
routing, and integration lifecycle are also owned by the provider plugin.

When updating the upstream-shaped modules, compare against both source packages
and reapply the documented Copilot adaptations. Focused regression coverage is
in:

- `test/github-copilot/copilot-chat-model.test.ts`
- `test/github-copilot/convert-to-copilot-messages.test.ts`
- `test/github-copilot/openai-responses-language-model.test.ts`
- `test/github-copilot/openai-responses-prepare-tools.test.ts`
- `test/github-copilot/models.test.ts`
- `test/plugin/provider-github-copilot.test.ts`
