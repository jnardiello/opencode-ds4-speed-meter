# opencode-ds4-speed-meter

Local speed-meter and DS4 dynamic-limits plugin for OpenCode 1.18.15 and
OpenAI-compatible providers.

- The server entrypoint reads `/v1/models` at startup and applies the current
  context and completion limits reported by DS4. Configured limits remain the
  fallback while DS4 is unavailable.
- The TUI entrypoint adds a persistent, muted `DS4  N.N tok/s` row to the
  session sidebar before the built-in Context block. Its provider, label, and
  telemetry endpoint are configurable.
- Every two seconds it computes the aggregate live rate as
  `delta(tokens_decoded) / delta(time)`. By default it probes `/v1/stats` and
  then `/metrics`, remembers the working endpoint, and only retries the other
  endpoint if the preferred one later fails. It shows `0.0 tok/s · idle` when
  both the interval delta and in-flight count are zero, preserves a final
  nonzero interval that has just completed, and shows `— tok/s · offline` when
  neither endpoint is reachable.
- The stats reader accepts the nested JSON endpoint provided by upstream DS4,
  Entrpi's existing sectioned text response, and Prometheus/OpenMetrics output
  from vLLM. For vLLM it derives the token counter from
  `vllm:generation_tokens_total` and adds the running and waiting request
  gauges.

Model requests are not modified, SSE responses are not intercepted, and no
toast is displayed. Telemetry requests reuse configured provider headers only
for same-origin URLs and never follow redirects.

## Requirements

- OpenCode 1.18.15 or newer.
- An OpenAI-compatible provider. The defaults use the ID `ds4`.
- A DS4 server whose `/v1/models` response reports the active model limits.
- For the live meter, `GET /v1/stats` must expose
  `server.requests_inflight` and `serving.tokens_decoded`. Entrpi v0.5.6 is
  supported, as is the compact nested JSON format described above. A vLLM
  Prometheus `/metrics` endpoint is also supported.

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

The manifest supplies these defaults to the TUI entrypoint:

```json
{
  "providerID": "ds4",
  "label": "DS4",
  "statsPaths": ["stats", "../metrics"],
  "intervalMs": 2000,
  "requestTimeoutMs": 1500
}
```

`label`, `statsPaths`, `statsPath`, `statsURL`, `intervalMs`, and
`requestTimeoutMs` apply only to the TUI entrypoint. Paths are resolved relative
to the provider's `baseURL`: with a base URL ending in `/v1`, `stats` selects
`/v1/stats` and `../metrics` selects `/metrics`. The ordered `statsPaths` list is
deduplicated after resolution. After the first successful response, that URL is
polled directly; if it stops working, the remaining URLs are tried and the new
success becomes preferred.

The legacy singular `statsPath` remains supported and forces one endpoint. An
explicit absolute `statsURL` also forces one endpoint and takes precedence over
all path options. `statsPath` takes precedence over `statsPaths`. Every resolved
URL must use HTTP(S) and have the same origin as the provider `baseURL`; redirects
are not followed, so provider authentication headers cannot leave that origin.

`timeoutMs` controls the server entrypoint's `/v1/models` startup request. The
server entrypoint continues to default to provider `ds4` independently of the
TUI override.

### Beast / vLLM TUI override

For a provider named `beast` whose OpenAI base URL ends in `/v1` and whose
Prometheus telemetry is at the origin-root `/metrics`, use this entry in
`tui.json`:

```json
{
  "plugin": [
    [
      "./plugins/opencode-ds4-speed-meter",
      {
        "providerID": "beast",
        "label": "Beast",
        "statsPaths": ["stats", "../metrics"],
        "intervalMs": 2000,
        "requestTimeoutMs": 1500
      }
    ]
  ]
}
```

The explicit `statsPaths` mirrors the default and only makes the intended order
visible; it may be omitted. The probe will discover `/metrics` after
`/v1/stats` fails, then cache `/metrics` for subsequent polls. To avoid even the
initial probe, set `"statsPath": "../metrics"`; use `statsURL` only when an
explicit same-origin absolute URL is preferable.

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
