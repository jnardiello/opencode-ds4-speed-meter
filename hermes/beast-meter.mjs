import { formatMeter } from "../ds4-speed-meter-core.mjs"
import { createBeastWidgetController } from "./widget-core.mjs"

export const BEAST_WIDGET = Object.freeze({
  id: "beast",
  name: "beast",
  help: "live Beast / vLLM telemetry",
  mode: "ambient",
  zone: "dock-bottom",
  width: 50,
})

function metricColor(theme, metric, formatted) {
  if (metric?.status === "offline") return theme.color.error ?? theme.color.warning
  if (metric?.status === "loading" || formatted.state === "IDLE") return theme.color.muted
  return theme.color.ok ?? theme.color.primary
}

function registerWidget(sdk, dependencies) {
  const { Box, Dialog, React, Text, defineWidgetApp, h } = sdk
  const makeController = dependencies.createController ?? createBeastWidgetController

  function BeastMeter({ t }) {
    const [view, setView] = React.useState(() => ({
      visible: false,
      descriptor: undefined,
      metric: undefined,
    }))

    React.useEffect(() => {
      const controller = makeController({ onChange: setView })
      setView(controller.snapshot())
      controller.start()
      return () => controller.stop()
    }, [])

    if (!view.visible || view.descriptor === undefined || view.metric === undefined) return null

    const label = view.descriptor.label
    const formatted = formatMeter(view.metric)
    const valueColor = metricColor(t, view.metric, formatted)
    return h(
      Dialog,
      { width: BEAST_WIDGET.width },
      h(
        Box,
        { flexDirection: "column" },
        h(
          Box,
          { flexDirection: "row" },
          h(Text, { bold: true, color: t.color.label }, label),
          h(Text, { color: valueColor }, `  ${formatted.primary}`),
        ),
        h(
          Box,
          { flexDirection: "row" },
          h(Text, { color: t.color.label }, " ".repeat(label.length)),
          h(Text, { color: valueColor }, `  ${formatted.secondary}`),
        ),
      ),
    )
  }

  const app = defineWidgetApp({
    ...BEAST_WIDGET,
    init: () => ({}),
    reduce: (state) => state,
    render: ({ t }) => h(BeastMeter, { t }),
  })
  sdk.openWidget(app, app.init(""))
  return app
}

export function createBeastWidgetRegister(dependencies = {}) {
  return (sdk) => registerWidget(sdk, dependencies)
}

export default function register(sdk) {
  return registerWidget(sdk, {})
}
