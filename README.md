# opencode-ds4-speed-meter

Local DS4 speed-meter and dynamic-limits plugin for OpenCode 1.18.15 and the
`ds4` OpenAI-compatible provider.

- The server entrypoint reads `/v1/models` at startup and applies the current
  context and completion limits reported by DS4. Configured limits remain the
  fallback while DS4 is unavailable.
- The TUI entrypoint adds a persistent, muted `DS4  N.N tok/s` row to the session
  sidebar before the built-in Context block.
- Every two seconds it computes the aggregate live rate as
  `delta(tokens_decoded) / delta(time)` from `/v1/stats`. It shows `0.0 tok/s ·
  idle` when both the interval delta and in-flight count are zero, preserves a
  final nonzero interval that has just completed, and shows `— tok/s · offline`
  when stats are not reachable.
- The stats reader accepts both the nested JSON endpoint provided by upstream
  DS4 and Entrpi's existing sectioned text response.

No request headers are injected, no SSE response is intercepted, and no toast
is displayed.

## Install

Copy the package into the OpenCode config tree, then register that installed
copy so OpenCode loads both `./server` and `./tui` without depending on this
workspace checkout:

```sh
opencode plugin ./plugins/opencode-ds4-speed-meter --global --force
```

Run the command from the OpenCode config directory containing
`opencode.jsonc`. It updates both the server and TUI plugin lists.

The manifest supplies these defaults to both config entries:

```json
{
  "providerID": "ds4",
  "intervalMs": 2000,
  "requestTimeoutMs": 1500
}
```

`intervalMs` and `requestTimeoutMs` apply only to the TUI entrypoint;
`timeoutMs` controls the server entrypoint's `/v1/models` startup request.

The sidebar is automatic on wide terminals. On narrow terminals, open the
normal OpenCode sidebar to see the metric.

## Test

```sh
npm test
```

or directly:

```sh
node --test ds4-speed-meter-core.test.mjs
```
