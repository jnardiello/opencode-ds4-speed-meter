# opencode-ds4-speed-meter

Compact vLLM engine-telemetry meter and DS4 dynamic-limits plugin for OpenCode
1.18.15 and OpenAI-compatible providers.

- The server entrypoint reads `/v1/models` at startup and applies the current
  context and completion limits reported by DS4. Configured limits remain the
  fallback while DS4 is unavailable.
- The TUI entrypoint adds a persistent two-line engine view to the session
  sidebar before the built-in Context block:

  ```text
  Beast  MIXED · P 12.4k · D 39.2 tok/s
         R1 Q0 · KV 38% · DS 68%
  ```

- `P` is the aggregate locally computed prefill-token delta, excluding local
  prefix-cache hits. `D` is the aggregate generation rate across all exposed
  engine series. `R/Q` are running/waiting requests, `KV` is the maximum
  reported KV-cache pressure, and `DS` is recent DSpark draft-token acceptance.
- The default poll interval remains two seconds. `P`, `D`, and `DS` use a
  six-second rolling window and the real elapsed time between samples. Counter
  resets, endpoint changes, offline periods, and entry into idle clear prior
  history. With work in flight but no counter movement, the state is `WORK`
  and both available activity values are zero.
- By default the reader probes `/v1/stats` and then `/metrics`, remembers the
  working endpoint, and only retries the other endpoint if the preferred one
  later fails.
- The stats reader accepts the nested JSON endpoint provided by upstream DS4,
  Entrpi's existing sectioned text response, and Prometheus/OpenMetrics output
  from vLLM. JSON and Entrpi retain the legacy decode rate and in-flight count;
  unavailable enriched fields render as `P —`, `Req N · KV — · DS —`.

Online engine states are `IDLE`, `QUEUE`, `WORK`, `PREFILL`, `DECODE`, and
`MIXED`; startup and telemetry failures render as `LOADING` and `OFFLINE`.

Model requests are not modified, SSE responses are not intercepted, and no
toast is displayed. Telemetry requests reuse configured provider headers only
for same-origin URLs and never follow redirects. These are vLLM engine metrics,
not physical per-GPU utilization; the plugin installs no node exporter or
daemon.

## Requirements

- OpenCode 1.18.15 or newer.
- An OpenAI-compatible provider. The defaults use the ID `ds4`.
- A DS4 server whose `/v1/models` response reports the active model limits.
- For the legacy live meter, `GET /v1/stats` must expose
  `server.requests_inflight` and `serving.tokens_decoded`. Entrpi v0.5.6 and the
  equivalent compact nested JSON format are supported.
- The enriched view uses a vLLM Prometheus `/metrics` endpoint. It requires
  `generation_tokens_total` and at least one running/waiting request gauge.
  `prompt_tokens_by_source_total`, `kv_cache_usage_perc`, and
  `spec_decode_num_{draft,accepted}_tokens_total` add `P`, `KV`, and `DS`.
  Both the `vllm:name` and `vllm_name` metric spellings are accepted.

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
  "requestTimeoutMs": 1500,
  "windowMs": 6000
}
```

`label`, `statsPaths`, `statsPath`, `statsURL`, `intervalMs`, `requestTimeoutMs`,
and `windowMs` apply only to the TUI entrypoint. `windowMs` controls the rolling
activity window and defaults to `6000`. Paths are resolved relative to
the provider's `baseURL`: with a base URL ending in `/v1`, `stats` selects
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
        "requestTimeoutMs": 1500,
        "windowMs": 6000
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

Counter and request series are summed so tensor-parallel or multi-engine
exposition is represented as one engine view. KV-cache pressure is instead the
maximum series value: summing utilization ratios would be meaningless. Only
`prompt_tokens_by_source_total{source="local_compute"}` feeds `P`; cached and
externally transferred prompt tokens are intentionally ignored.

The sidebar is automatic on wide terminals. On narrow terminals, open the
normal OpenCode sidebar to see the metric.

## Verify

With DS4 running, `opencode debug config` should show the context and output
limits reported by `/v1/models`. In a session sidebar, the plugin should move
through the applicable engine states and return to `IDLE` as soon as no request
is running or waiting. Examples:

```text
Beast  IDLE · P 0 · D 0.0 tok/s
       R0 Q0 · KV 0% · DS —

Beast  MIXED · P 12.4k · D 39.2 tok/s
       R1 Q0 · KV 38% · DS 68%

Beast  OFFLINE · P — · D — tok/s
       Req — · KV — · DS —
```

`DS —` means acceptance is not currently calculable: for example, no recent
draft delta exists, one of the counters is unavailable, or the window has just
been reset. It does not indicate a telemetry error by itself.

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
