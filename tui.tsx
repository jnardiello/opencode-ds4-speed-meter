/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, type Accessor } from "solid-js"
import { createStatsPoller, formatMeter, statsTargets, tuiOptions } from "./ds4-speed-meter-core.mjs"

type Metric =
  | { status: "loading" }
  | { status: "offline" }
  | {
      status: "online"
      rate: number
      requestsInflight: number
      requestsRunning?: number
      requestsWaiting?: number
      prefillRate?: number
      kvCacheUsage?: number
      draftAcceptance?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// The provider list is populated by the sync calls in setup; until the first
// sync completes, resolveProvider finds nothing and the meter cannot poll.
// Resolve the configured provider from the TUI location data (V2 Provider.Info).
function resolveProvider(context: any, providerID: string | undefined) {
  if (!providerID) return
  const location = context.location ?? context.data.location.default()
  const providers = context.data.location.provider.list(location) ?? []
  return providers.find((item: any) => isRecord(item) && item.id === providerID)
}

// Adapt a V2 Provider.Info (settings.baseURL/apiKey, headers) to the legacy
// provider shape the core helpers expect (options.baseURL/apiKey/headers).
function toLegacyProvider(info: unknown) {
  const record = isRecord(info) ? info : {}
  const settings = isRecord(record.settings) ? record.settings : {}
  const baseURL = typeof settings.baseURL === "string" ? settings.baseURL : undefined
  return {
    api: baseURL,
    options: {
      baseURL,
      apiKey: typeof settings.apiKey === "string" ? settings.apiKey : undefined,
      headers: isRecord(record.headers) ? record.headers : undefined,
    },
  }
}

function View(props: { context: any; label: string; metric: Accessor<Metric> }) {
  const theme = () => props.context.theme
  const formatted = () => formatMeter(props.metric())
  const warningColor = () => theme()?.text?.warning ?? theme()?.text?.muted
  const metricColor = () => (props.metric().status === "offline" ? warningColor() : theme()?.text?.muted)

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={2}>
        <text fg={theme()?.text?.base}>
          <b>{props.label}</b>
        </text>
        <text fg={metricColor()}>{formatted().primary}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme()?.text?.base}>{" ".repeat(props.label.length)}</text>
        <text fg={metricColor()}>{formatted().secondary}</text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "local.opencode-speed-meter.tui",
  setup(context: any) {
    const options = tuiOptions(context.options)
    const location = context.location ?? context.data.location.default()
    const [metric, setMetric] = createSignal<Metric>({ status: "loading" })
    const poller = createStatsPoller({
      intervalMs: options.intervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      windowMs: options.windowMs,
      fetchImpl: globalThis.fetch,
      getTargets() {
        const info = resolveProvider(context, options.providerID)
        if (!info) return
        try {
          return statsTargets(toLegacyProvider(info), options)
        } catch {
          return
        }
      },
      onUpdate(value: Metric) {
        setMetric(value)
      },
    })

    // Keep the provider list fresh so a provider that materializes after
    // startup (or edits to opencode.json) is picked up without a restart.
    const resync = setInterval(() => {
      void Promise.resolve(context.data.location.provider.sync(location)).catch(() => {})
    }, 30_000)
    // Prime the provider list immediately: until the first sync completes the
    // polls find no targets and the meter would sit on its initial state.
    void Promise.resolve(context.data.location.provider.sync(location)).catch(() => {})

    poller.start()

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <View context={context} label={options.label} metric={metric} />,
    })

    return () => {
      clearInterval(resync)
      poller.stop()
      if (typeof unregister === "function") (unregister as () => void)()
    }
  },
})
