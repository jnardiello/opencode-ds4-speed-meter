import { join } from "node:path"

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { createBeastTelemetryLifecycle } from "./pi-beast-telemetry.mjs"

export default function beastTelemetryExtension(pi: ExtensionAPI) {
  pi.registerFlag("beast-stats-url", {
    description: "Override the same-origin Beast telemetry endpoint",
    type: "string",
  })

  createBeastTelemetryLifecycle(pi, {
    configPath: join(getAgentDir(), "extensions", "beast-telemetry.json"),
    getFlag: () => pi.getFlag("beast-stats-url"),
  })
}
