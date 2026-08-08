import type { Plugin } from "@opencode-ai/plugin"
import { createDS4SpeedMeterServerPlugin } from "./ds4-speed-meter-core.mjs"

const server: Plugin = async (input, options) => createDS4SpeedMeterServerPlugin(options)(input)

export default {
  id: "local.opencode-ds4-speed-meter.server",
  server,
}
