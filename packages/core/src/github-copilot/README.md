# GitHub Copilot Transports and AI SDK Adapters

## Responses WebSockets

Models advertising `ws:/responses` in Copilot's authenticated `/models` response
use the native `@opencode/ai/providers/github-copilot` package. It composes the
shared Responses protocol with Copilot's stateless replay and request metadata,
then uses Core's session-scoped WebSocket manager for incremental continuation,
reconnection, and HTTP fallback. Endpoint support is discovered rather than
inferred from model names. Models using `/v1/messages`, including Claude, keep
the native Anthropic HTTP route; other models keep the adapters below.

WebSockets are enabled by default for Copilot. To force HTTP, set the provider
policy in `opencode.jsonc`:

```jsonc
{
  "providers": {
    "github-copilot": {
      "settings": { "transport": "http" },
    },
  },
}
```

Remove that override or set it to `"websocket"` to restore WebSockets. If the
connection cannot open, the existing session manager sends the complete request
over HTTP. A rejected incremental continuation clears its checkpoint before a
full retry. Changes to connection identity, such as account or endpoint changes,
open a fresh connection.

### Verification

These tests use local servers and fixture credentials; no Copilot subscription
is required. Run from the indicated package directories:

```bash
# packages/ai
bun test --timeout 30000 test/provider/github-copilot-responses.test.ts

# packages/core (the test runner isolates HOME and credentials)
bun run test test/github-copilot test/plugin/provider-github-copilot.test.ts \
  test/session-model-transport.test.ts test/session-model-transport-live.test.ts
```

For live acceptance, use an account entitled to the intended models. Copilot
Free currently provides automatic selection only, so it cannot guarantee access
to a particular model or transport. See [GitHub's current plans](https://docs.github.com/en/copilot/get-started/plans).

1. From the repository root, run `bun install --frozen-lockfile`, then
   `bun run dev --standalone`. The standalone server runs this checkout.
2. Use `/connect` to sign in to Copilot on that computer and `/models` to choose
   an advertised OpenAI model. Existing company credentials do not need to be
   copied to another computer.
3. Ask it to read a small project, make an edit, and run a check. Add a follow-up
   request to exercise user-to-tool and tool-to-user continuation on a long
   conversation. Repeat with the other intended OpenAI model.
4. Repeat the same scenario with the HTTP policy above, then with a Claude
   model. Compare correctness and the original failure, not just latency.
5. To confirm the transport, start with
   `OPENCODE_LOG_LEVEL=DEBUG bun run dev --standalone --print-logs`. Look for
   `session websocket connected`, `session websocket reused`, and
   `session websocket sending` with `mode: incremental`. A configured WebSocket
   preference alone does not prove it was used; a failed upgrade logs
   `session websocket connect failed; using http`.
6. If the original error remains, retain the model ID, status/error code,
   request ID, and whether the call used WebSockets or HTTP. Do not share tokens,
   complete prompts, or company source in diagnostics.

Live inference is a separate acceptance step from the local protocol tests.
WebSockets reduce repeated history uploads; they do not increase the model's
context window or remove gateway limits.

### macOS

The `Copilot macOS` workflow runs the protocol and session tests on native Apple
Silicon and Intel runners, builds the CLI with its embedded web UI, and executes
the built binary. Its downloadable `.tar.gz` artifacts preserve executable
permissions. The Intel build uses Bun's baseline target for CPU compatibility.

To run from source on a Mac, use Node 24 and the Bun version pinned by the root
`packageManager` field, then run:

```bash
git clone https://github.com/JorgeMuehlebach/opencode.git
cd opencode
bun install --frozen-lockfile
bun run dev --standalone
```

Sign in with `/connect` and follow the live acceptance procedure above. Build a
local executable with `bun run --cwd packages/cli build --single --skip-install`.
Copilot authentication and WebSocket behavior use the same implementation on
macOS and Linux; the macOS workflow does not use a Copilot subscription.

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
