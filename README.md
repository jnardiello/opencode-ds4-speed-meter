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

## Requirements

- OpenCode 1.18.15 or newer.
- An OpenAI-compatible provider configured with the ID `ds4`.
- A DS4 server whose `/v1/models` response reports the active model limits.
- For the live meter, `GET /v1/stats` must expose
  `server.requests_inflight` and `serving.tokens_decoded`. Entrpi v0.5.6 is
  supported, as is the compact nested JSON format described above.

## Install

First locate the active OpenCode config directory:

```sh
opencode debug paths
```

The default is `~/.config/opencode`. If the command reports a different config
directory, substitute that path in the commands below.

Clone the plugin inside the config tree:

```sh
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/jnardiello/opencode-ds4-speed-meter.git \
  ~/.config/opencode/plugins/opencode-ds4-speed-meter
```

Then register both package entrypoints:

```sh
cd ~/.config/opencode
opencode plugin ./plugins/opencode-ds4-speed-meter --global --force
```

The command updates the plugin lists in both `opencode.json`/`opencode.jsonc`
and `tui.json`. Restart OpenCode after installation.

The provider configuration should contain a model entry whose ID matches the
one returned by DS4. This minimal example uses fallback limits until the server
reports its live values:

```jsonc
{
  "model": "ds4/deepseek-v4-flash",
  "provider": {
    "ds4": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "local"
      },
      "models": {
        "deepseek-v4-flash": {
          "limit": {
            "context": 128000,
            "output": 128000
          }
        }
      }
    }
  }
}
```

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

## Verify

With DS4 running, `opencode debug config` should show the context and output
limits reported by `/v1/models`. In a session sidebar, the plugin should show
one of these states:

```text
DS4  31.7 tok/s
DS4  0.0 tok/s · idle
DS4  — tok/s · offline
```

## Update

```sh
git -C ~/.config/opencode/plugins/opencode-ds4-speed-meter pull --ff-only
```

Restart OpenCode after updating. For a custom XDG config directory, substitute
the path printed by `opencode debug paths`.

## Test

```sh
npm test
```

or directly:

```sh
node --test ds4-speed-meter-core.test.mjs
```
