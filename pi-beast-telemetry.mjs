import { readFile as defaultReadFile } from "node:fs/promises"

import { createStatsPoller, formatMeterLines, statsTargets } from "./ds4-speed-meter-core.mjs"

export const BEAST_WIDGET_KEY = "beast-telemetry"

export const DEFAULT_PI_OPTIONS = Object.freeze({
  label: "Beast",
  providerIDs: Object.freeze(["beast", "ds4", "vllm"]),
  statsPaths: Object.freeze(["stats", "../metrics"]),
  intervalMs: 2_000,
  requestTimeoutMs: 1_500,
  windowMs: 6_000,
})

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonemptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function nonemptyStringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`)
  }
  return value.map((item) => nonemptyString(item, `${name} entries`))
}

function positiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function piOptions(value = {}) {
  if (!isRecord(value)) throw new Error("configuration must be a JSON object")

  const options = {
    label:
      value.label === undefined ? DEFAULT_PI_OPTIONS.label : nonemptyString(value.label, "label"),
    providerIDs:
      value.providerIDs === undefined
        ? [...DEFAULT_PI_OPTIONS.providerIDs]
        : nonemptyStringArray(value.providerIDs, "providerIDs"),
    statsPaths:
      value.statsPaths === undefined
        ? [...DEFAULT_PI_OPTIONS.statsPaths]
        : nonemptyStringArray(value.statsPaths, "statsPaths"),
    intervalMs:
      value.intervalMs === undefined
        ? DEFAULT_PI_OPTIONS.intervalMs
        : positiveInteger(value.intervalMs, "intervalMs"),
    requestTimeoutMs:
      value.requestTimeoutMs === undefined
        ? DEFAULT_PI_OPTIONS.requestTimeoutMs
        : positiveInteger(value.requestTimeoutMs, "requestTimeoutMs"),
    windowMs:
      value.windowMs === undefined
        ? DEFAULT_PI_OPTIONS.windowMs
        : positiveInteger(value.windowMs, "windowMs"),
  }

  if (value.statsURL !== undefined) options.statsURL = nonemptyString(value.statsURL, "statsURL")
  return options
}

export async function loadPiOptions(configPath, readFileImpl = defaultReadFile) {
  let source
  try {
    source = await readFileImpl(configPath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return piOptions()
    throw new Error(`cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    return piOptions(parsed)
  } catch (error) {
    throw new Error(`invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function optionalStatsURL(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function resolveStatsSelection(flagValue, options) {
  const flagStatsURL = optionalStatsURL(flagValue)
  if (flagStatsURL !== undefined) return { source: "flag", statsURL: flagStatsURL }

  const configuredStatsURL = optionalStatsURL(options?.statsURL)
  if (configuredStatsURL !== undefined) return { source: "config", statsURL: configuredStatsURL }

  return {
    source: "model",
    statsPaths: [...(options?.statsPaths ?? DEFAULT_PI_OPTIONS.statsPaths)],
  }
}

export function modelSupportsTelemetry(model, options, selection) {
  if (!isRecord(model) || typeof model.provider !== "string" || !model.provider) return false
  if (selection?.statsURL !== undefined) return true
  return (options?.providerIDs ?? DEFAULT_PI_OPTIONS.providerIDs).includes(model.provider)
}

export function statsTargetsForModel(model, auth, selection) {
  if (!isRecord(model) || typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    throw new Error("model has no baseUrl")
  }
  if (!isRecord(auth) || auth.ok !== true) {
    throw new Error(isRecord(auth) && typeof auth.error === "string" ? auth.error : "model authentication is unavailable")
  }

  const provider = {
    options: {
      baseURL: model.baseUrl,
      headers: {
        ...(isRecord(model.headers) ? model.headers : {}),
        ...(isRecord(auth.headers) ? auth.headers : {}),
      },
    },
  }
  if (typeof auth.apiKey === "string" && auth.apiKey) provider.options.apiKey = auth.apiKey

  return statsTargets(provider, selection)
}

export function widgetLines(label, metric) {
  return formatMeterLines(nonemptyString(label, "label"), metric)
}

export function createBeastTelemetryLifecycle(pi, dependencies) {
  if (!pi || typeof pi.on !== "function") throw new Error("Pi extension API is required")
  if (typeof dependencies?.configPath !== "string" || !dependencies.configPath) {
    throw new Error("configPath is required")
  }

  const readFileImpl = dependencies.readFileImpl ?? defaultReadFile
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const makePoller = dependencies.createPoller ?? createStatsPoller
  const getFlag = dependencies.getFlag ?? (() => undefined)

  let generation = 0
  let poller
  let widgetContext
  let widgetVisible = false
  let configurationWarned = false
  let runtimeWarned = false
  let disabled = false

  function notifyOnce(ctx, error, kind) {
    if (ctx.mode !== "tui") return
    if (kind === "configuration") {
      if (configurationWarned) return
      configurationWarned = true
    } else {
      if (runtimeWarned) return
      runtimeWarned = true
    }
    const message = error instanceof Error ? error.message : String(error)
    const outcome = kind === "configuration" ? "extension disabled" : "telemetry unavailable"
    ctx.ui.notify(`[beast-telemetry] ${message}; ${outcome}`, "warning")
  }

  function stopPoller() {
    const current = poller
    poller = undefined
    current?.stop()
  }

  function clearWidget(ctx = widgetContext) {
    if (!widgetVisible || ctx?.mode !== "tui") return
    widgetVisible = false
    ctx.ui.setWidget(BEAST_WIDGET_KEY, undefined, { placement: "aboveEditor" })
  }

  function showWidget(ctx, label, metric) {
    if (ctx.mode !== "tui") return
    widgetContext = ctx
    widgetVisible = true
    ctx.ui.setWidget(BEAST_WIDGET_KEY, widgetLines(label, metric), { placement: "aboveEditor" })
  }

  async function configure(ctx, model = ctx.model) {
    const token = ++generation
    stopPoller()

    if (ctx.mode !== "tui" || disabled) return false
    widgetContext = ctx

    let options
    try {
      options = await loadPiOptions(dependencies.configPath, readFileImpl)
    } catch (error) {
      if (token !== generation) return false
      disabled = true
      clearWidget(ctx)
      notifyOnce(ctx, error, "configuration")
      return false
    }
    if (token !== generation) return false

    const selection = resolveStatsSelection(getFlag(), options)
    if (!modelSupportsTelemetry(model, options, selection)) {
      clearWidget(ctx)
      return false
    }

    showWidget(ctx, options.label, { status: "loading" })

    let auth
    try {
      auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    } catch (error) {
      auth = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (token !== generation) return false

    let targets
    try {
      targets = statsTargetsForModel(model, auth, selection)
    } catch (error) {
      showWidget(ctx, options.label, { status: "offline" })
      notifyOnce(ctx, error, "runtime")
      return false
    }

    let candidate
    try {
      candidate = makePoller({
        intervalMs: options.intervalMs,
        requestTimeoutMs: options.requestTimeoutMs,
        windowMs: options.windowMs,
        fetchImpl,
        getTargets: () => targets,
        onUpdate(metric) {
          if (token !== generation || candidate !== poller) return
          showWidget(ctx, options.label, metric)
        },
      })
    } catch (error) {
      showWidget(ctx, options.label, { status: "offline" })
      notifyOnce(ctx, error, "runtime")
      return false
    }

    if (token !== generation) {
      candidate.stop()
      return false
    }

    poller = candidate
    candidate.start()
    return true
  }

  function cleanup(ctx) {
    generation += 1
    stopPoller()
    clearWidget(ctx)
  }

  pi.on("session_start", (_event, ctx) => configure(ctx))
  pi.on("model_select", (event, ctx) => configure(ctx, event.model))
  pi.on("session_shutdown", (_event, ctx) => cleanup(ctx))

  return {
    configure,
    cleanup,
    get disabled() {
      return disabled
    },
    get generation() {
      return generation
    },
    get poller() {
      return poller
    },
  }
}
