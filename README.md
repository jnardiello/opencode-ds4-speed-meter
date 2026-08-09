# opencode-ds4-speed-meter

**Beast Engine Telemetry Meter** · version 0.5.0

`opencode-ds4-speed-meter` is a compact, multi-host vLLM engine-telemetry
meter for OpenCode, Pi, and the modern Hermes 0.20 TUI. The repository name and
its OpenCode/DS4 dynamic-limit compatibility are retained: on OpenCode, the
server entrypoint reads `/v1/models` at startup and applies the context and
completion limits reported by DS4. Configured limits remain the fallback while
DS4 is unavailable.

It reports engine throughput and scheduler health, not workstation hardware
utilization. It does not install a node exporter or daemon, and it is not a
classic standalone CLI or physical per-GPU telemetry tool.

## Meter output

The OpenCode sidebar, Pi extension, and Hermes widget each render a persistent
two-line engine view:

```text
Beast  MIXED · P 12.4k · D 39.2 tok/s
       R1 Q0 · KV 38% · DS 68%
```

- `P` is the recent aggregate **locally computed prefill** token delta. Prefix
  cache hits (and transferred or otherwise non-local prompt tokens) are
  excluded.
- `D` is the aggregate decode rate for the whole engine, across all exposed
  engine series.
- `R` and `Q` are the running and waiting request counts.
- `KV` is the maximum reported KV-cache pressure across the series; percentages
  are not summed.
- `DS` is recent draft-token acceptance: accepted draft tokens divided by draft
  tokens in the rolling window.

Online engine states are `IDLE`, `QUEUE`, `WORK`, `PREFILL`, `DECODE`, and
`MIXED`; startup and telemetry failures render as `LOADING` and `OFFLINE`.
With work in flight but no counter movement, the state is `WORK` and available
activity values are zero. `DS —` means acceptance cannot currently be computed
(for example, there is no recent draft delta or the window was reset); it is not
by itself a telemetry error.

## Telemetry behaviour and boundaries

- The default stats paths are `/v1/stats` and `/metrics` (configured as
  `stats` and `../metrics` for a provider base URL ending in `/v1`). The reader
  remembers the last successful endpoint and retries the other path only after
  its preferred endpoint fails.
- Default timing is a **2 s** poll interval, **1.5 s** request timeout, and a
  **6 s** rolling window. `P`, `D`, and `DS` use actual elapsed sample time.
  Counter resets, endpoint changes, offline periods, and idle entry clear the
  prior window.
- The reader accepts DS4 nested JSON, Entrpi's sectioned text response, and
  Prometheus/OpenMetrics from vLLM. JSON and Entrpi retain the legacy decode
  rate and in-flight count; unavailable enriched fields render as `P —`,
  `Req N · KV — · DS —`.
- In the OpenCode and Pi integrations, resolved telemetry URLs must be HTTP(S)
  and same-origin with the configured provider/model `baseURL`. Redirects are
  not followed, so provider authentication headers cannot leave that origin.
- Model requests are not modified and SSE responses are not intercepted.
  Hermes metrics requests carry **no HTTP authentication**: never put a secret
  or credential bridge in front of this widget's metrics endpoint.
- In Hermes, concurrent `pre_api_request` events are intentionally
  last-write-wins: the last event received supplies the meter context.

Counter and request series are summed so tensor-parallel or multi-engine
exposition becomes one engine view. Only
`prompt_tokens_by_source_total{source="local_compute"}` feeds `P`.
`generation_tokens_total`, a running or waiting request gauge,
`kv_cache_usage_perc`, and
`spec_decode_num_{draft,accepted}_tokens_total` provide the enriched metrics.
Both `vllm:name` and `vllm_name` metric spellings are accepted.

## OpenCode

### Requirements

- OpenCode 1.18.15 or newer.
- An OpenAI-compatible provider; the compatibility defaults use ID `ds4`.
- A DS4 server whose `/v1/models` response reports active model limits.
- For the legacy live meter, `GET /v1/stats` exposing
  `server.requests_inflight` and `serving.tokens_decoded`. Entrpi v0.5.6 and
  the equivalent compact nested JSON format are supported.

### Install

First locate the active OpenCode config directory:

```sh
opencode debug paths
```

The default is `~/.config/opencode`. If the command reports a different config
directory, substitute that path below.

Clone the plugin inside the config tree and register both package entrypoints:

```sh
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/jnardiello/opencode-ds4-speed-meter.git \
  ~/.config/opencode/plugins/opencode-ds4-speed-meter
cd ~/.config/opencode
opencode plugin ./plugins/opencode-ds4-speed-meter --global --force
```

The registration command updates the plugin lists in both
`opencode.json`/`opencode.jsonc` and `tui.json`. Restart OpenCode afterwards.

### Provider and TUI configuration

The provider needs a model ID matching DS4's `/v1/models` response. This
example uses configured limits until the live server reports theirs:

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

The TUI entrypoint defaults are:

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

`label`, `statsPaths`, `statsPath`, `statsURL`, `intervalMs`,
`requestTimeoutMs`, and `windowMs` apply only to the TUI entrypoint.
`statsPaths` is ordered and deduplicated after resolution. The singular
`statsPath` forces one endpoint; an absolute `statsURL` also forces one endpoint
and takes precedence over all path options. `statsPath` takes precedence over
`statsPaths`.

For a provider named `beast`, whose OpenAI base URL ends in `/v1` and whose
Prometheus telemetry is at origin-root `/metrics`, add this entry to `tui.json`:

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

The explicit paths simply show the default probing order. To avoid the initial
`/v1/stats` probe, set `"statsPath": "../metrics"`; use `statsURL` only for an
explicit same-origin absolute URL. `timeoutMs` independently controls the
server entrypoint's `/v1/models` startup request, which still defaults to the
`ds4` provider.

On a narrow terminal, open the normal OpenCode sidebar to see the metric.

## Pi

Install the same package as a Pi extension:

```sh
pi install git:github.com/jnardiello/opencode-ds4-speed-meter
```

Its persistent configuration lives at
`getAgentDir()/extensions/beast-telemetry.json`. A complete configuration is:

```jsonc
{
  "label": "Beast",
  "providerIDs": ["beast"],
  "statsPaths": ["stats", "../metrics"],
  "intervalMs": 2000,
  "requestTimeoutMs": 1500,
  "windowMs": 6000,
  // Optional explicit same-origin endpoint; it overrides statsPaths.
  "statsURL": "http://127.0.0.1:8000/metrics"
}
```

Set the metrics endpoint for an individual Pi run with
`--beast-stats-url`, for example:

```sh
pi --beast-stats-url http://127.0.0.1:8000/metrics
```

`--beast-stats-url` must be same-origin with the model's `baseUrl`; use the
endpoint for the target Beast host. This is how separate Pi agents can observe
separate engine hosts. The same 2 s / 1.5 s / 6 s defaults and metric semantics
apply.

## Hermes 0.20 TUI

Install and enable the modern Hermes plugin:

```sh
hermes plugins install jnardiello/opencode-ds4-speed-meter
hermes plugins enable beast-telemetry
```

Register its widget with the TUI:

```sh
HERMES_DATA_DIR="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_DATA_DIR/tui-widgets"
ln -sfn "$HERMES_DATA_DIR/plugins/beast-telemetry/hermes/beast-meter.mjs" \
  "$HERMES_DATA_DIR/tui-widgets/beast-meter.mjs"
```

Restart Hermes, or run `/widgets-reload`, to load the widget. Configure it under
`plugins.entries.beast-telemetry`; Hermes option names use `snake_case`:
`stats_url`, `stats_paths`, `label`, `interval_ms`, `request_timeout_ms`, and
`window_ms`. `stats_url`, when present, must be same-origin with the active
model's `base_url`. Point it at a metrics endpoint that is intentionally
accessible without HTTP authentication. Do not embed secrets in this
configuration or add a secret-bearing bridge for the widget. This integration
targets `hermes --tui`; it does not add a widget to the classic CLI or web UI.

## Verify and update

With DS4 running, `opencode debug config` should show context and output limits
reported by `/v1/models`. The meter should move through applicable engine states
and return to `IDLE` as soon as no request is running or waiting:

```text
Beast  IDLE · P 0 · D 0.0 tok/s
       R0 Q0 · KV 0% · DS —

Beast  OFFLINE · P — · D — tok/s
       Req — · KV — · DS —
```

To update the OpenCode checkout:

```sh
git -C ~/.config/opencode/plugins/opencode-ds4-speed-meter pull --ff-only
```

Restart OpenCode after updating. For a custom XDG config directory, substitute
the path printed by `opencode debug paths`.

## Test

```sh
npm run check
```

The JavaScript suite alone is available as:

```sh
npm test
```
