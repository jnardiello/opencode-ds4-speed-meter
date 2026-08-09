/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, type Accessor } from "solid-js"
import { createStatsPoller, statsTargets, tuiOptions } from "./ds4-speed-meter-core.mjs"

type Metric =
  | { status: "loading" }
  | { status: "offline" }
  | { status: "online"; rate: number; requestsInflight: number }

function provider(api: TuiPluginApi, providerID: string) {
  const configured = api.state.config.provider?.[providerID]
  const runtime = api.state.provider.find((item) => item.id === providerID)
  if (!configured && !runtime) return
  return {
    api: configured?.api,
    options: {
      ...(configured?.options ?? {}),
      ...(runtime?.options ?? {}),
    },
  }
}

function View(props: { api: TuiPluginApi; label: string; metric: Accessor<Metric> }) {
  const theme = () => props.api.theme.current
  const value = () => {
    const metric = props.metric()
    if (metric.status === "loading") return "— tok/s"
    if (metric.status === "offline") return "— tok/s · offline"
    if (metric.requestsInflight === 0 && metric.rate === 0) return "0.0 tok/s · idle"
    return `${metric.rate.toFixed(1)} tok/s`
  }

  return (
    <box flexDirection="row" gap={2}>
      <text fg={theme().text}>
        <b>{props.label}</b>
      </text>
      <text fg={props.metric().status === "offline" ? theme().warning : theme().textMuted}>{value()}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = tuiOptions(rawOptions)
  const [metric, setMetric] = createSignal<Metric>({ status: "loading" })
  const poller = createStatsPoller({
    intervalMs: options.intervalMs,
    requestTimeoutMs: options.requestTimeoutMs,
    fetchImpl: globalThis.fetch,
    getTargets() {
      const value = provider(api, options.providerID)
      if (!value) return
      try {
        return statsTargets(value, options)
      } catch {
        return
      }
    },
    onUpdate(value: Metric) {
      setMetric(value)
    },
  })

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content() {
        return <View api={api} label={options.label} metric={metric} />
      },
    },
  })

  api.lifecycle.onDispose(() => poller.stop())
  poller.start()
}

export default {
  id: "local.opencode-ds4-speed-meter.tui",
  tui,
}
