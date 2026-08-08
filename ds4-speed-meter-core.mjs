const DEFAULT_PROVIDER_ID = "ds4"
const DEFAULT_MODELS_TIMEOUT_MS = 2_000
const DEFAULT_STATS_INTERVAL_MS = 2_000
const DEFAULT_STATS_TIMEOUT_MS = 1_500

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function configuredHeaders(provider) {
  const headers = new Headers()
  const raw = provider.options?.headers
  if (isRecord(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === "string") headers.set(name, value)
    }
  }

  const apiKey = provider.options?.apiKey
  if (typeof apiKey === "string" && apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKey}`)
  }
  return headers
}

function providerBaseURL(provider) {
  const raw = provider?.options?.baseURL ?? provider?.api
  if (typeof raw !== "string" || !raw.trim()) throw new Error("provider ds4 has no baseURL")
  return raw.trim().replace(/\/+$/, "")
}

function endpointURL(provider, endpoint) {
  return `${providerBaseURL(provider)}/${endpoint}`
}

function withTimeout(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === "function") timer.unref()
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

function optionString(options, key, fallback) {
  const value = options?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function optionPositiveInteger(options, key, fallback) {
  return positiveInteger(options?.[key]) ?? fallback
}

export function serverOptions(options = {}) {
  return {
    providerID: optionString(options, "providerID", DEFAULT_PROVIDER_ID),
    timeoutMs: optionPositiveInteger(options, "timeoutMs", DEFAULT_MODELS_TIMEOUT_MS),
  }
}

export function tuiOptions(options = {}) {
  return {
    providerID: optionString(options, "providerID", DEFAULT_PROVIDER_ID),
    intervalMs: optionPositiveInteger(options, "intervalMs", DEFAULT_STATS_INTERVAL_MS),
    requestTimeoutMs: optionPositiveInteger(options, "requestTimeoutMs", DEFAULT_STATS_TIMEOUT_MS),
  }
}

export function statsTarget(provider) {
  const headers = configuredHeaders(provider)
  headers.set("accept", "application/json")
  return {
    url: endpointURL(provider, "stats"),
    headers,
  }
}

export async function refreshDS4Limits(provider, fetchImpl, timeoutMs = DEFAULT_MODELS_TIMEOUT_MS) {
  if (!isRecord(provider)) throw new Error("provider ds4 is not configured")
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")

  const timeout = withTimeout(timeoutMs)
  let response
  try {
    response = await fetchImpl(endpointURL(provider, "models"), {
      method: "GET",
      headers: configuredHeaders(provider),
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }

  if (!response?.ok) throw new Error(`/models returned HTTP ${response?.status ?? "unknown"}`)
  const payload = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("/models returned an invalid payload")

  const remoteByID = new Map(
    payload.data
      .filter((item) => isRecord(item) && typeof item.id === "string")
      .map((item) => [item.id, item]),
  )
  const configuredModels = isRecord(provider.models) ? provider.models : {}
  const applied = []

  for (const [modelID, rawModel] of Object.entries(configuredModels)) {
    if (!isRecord(rawModel)) continue
    const apiID = typeof rawModel.id === "string" && rawModel.id ? rawModel.id : modelID
    const remote = remoteByID.get(apiID)
    if (!remote) continue

    const topProvider = isRecord(remote.top_provider) ? remote.top_provider : undefined
    const context = positiveInteger(remote.context_length) ?? positiveInteger(topProvider?.context_length)
    const output = positiveInteger(remote.max_output_tokens) ?? positiveInteger(topProvider?.max_completion_tokens)
    if (context === undefined && output === undefined) continue

    const limit = isRecord(rawModel.limit) ? rawModel.limit : {}
    rawModel.limit = limit
    if (context !== undefined) limit.context = context
    if (output !== undefined) limit.output = output
    applied.push({ modelID, context, output })
  }

  if (applied.length === 0) throw new Error("/models did not contain a configured ds4 model with valid limits")
  return applied
}

function parseTextStats(text) {
  const fields = new Map()
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue
    const separator = value.indexOf(":")
    if (separator <= 0) continue
    fields.set(value.slice(0, separator).trim(), value.slice(separator + 1).trim())
  }

  const tokensDecoded = Number(fields.get("tokens_decoded"))
  const requestsInflight = Number(fields.get("requests_inflight"))
  if (nonnegativeNumber(tokensDecoded) === undefined || nonnegativeInteger(requestsInflight) === undefined) {
    throw new Error("/stats returned an invalid text payload")
  }
  return { tokensDecoded, requestsInflight }
}

export function parseStatsPayload(payload) {
  if (typeof payload === "string") {
    const text = payload.trim()
    if (!text) throw new Error("/stats returned an empty payload")
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return parseStatsPayload(JSON.parse(text))
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("/stats returned invalid JSON")
        throw error
      }
    }
    return parseTextStats(text)
  }

  if (!isRecord(payload)) throw new Error("/stats returned an invalid payload")
  const server = isRecord(payload.server) ? payload.server : payload
  const serving = isRecord(payload.serving) ? payload.serving : payload
  const tokensDecoded = nonnegativeNumber(serving.tokens_decoded)
  const requestsInflight = nonnegativeInteger(server.requests_inflight)
  if (tokensDecoded === undefined || requestsInflight === undefined) {
    throw new Error("/stats returned an invalid JSON payload")
  }
  return { tokensDecoded, requestsInflight }
}

export function calculateDecodeRate(previous, current) {
  if (previous === undefined) return 0
  const elapsedSeconds = (current.sampledAt - previous.sampledAt) / 1_000
  const decoded = current.tokensDecoded - previous.tokensDecoded
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || !Number.isFinite(decoded) || decoded < 0) return 0
  return decoded / elapsedSeconds
}

function defaultTimers() {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }
}

export function createStatsPoller(options) {
  if (typeof options?.fetchImpl !== "function") throw new Error("fetch is unavailable")
  if (typeof options?.getTarget !== "function") throw new Error("getTarget is required")
  if (typeof options?.onUpdate !== "function") throw new Error("onUpdate is required")

  const intervalMs = positiveInteger(options.intervalMs) ?? DEFAULT_STATS_INTERVAL_MS
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs) ?? DEFAULT_STATS_TIMEOUT_MS
  const now = typeof options.now === "function" ? options.now : Date.now
  const timers = options.timers ?? defaultTimers()
  let interval
  let requestTimer
  let requestController
  let previous
  let targetURL
  let active = false
  let started = false
  let stopped = false

  function emit(value) {
    if (stopped) return
    try {
      options.onUpdate(value)
    } catch {
      // UI rendering failures must not break future telemetry samples.
    }
  }

  async function poll() {
    if (stopped || active) return false
    active = true
    const controller = new AbortController()
    requestController = controller
    requestTimer = timers.setTimeout(() => controller.abort(), requestTimeoutMs)
    if (typeof requestTimer?.unref === "function") requestTimer.unref()

    try {
      const target = options.getTarget()
      if (!target || typeof target.url !== "string" || !target.url) {
        previous = undefined
        targetURL = undefined
        emit({ status: "offline" })
        return false
      }
      if (targetURL !== target.url) {
        previous = undefined
        targetURL = target.url
      }

      const response = await options.fetchImpl(target.url, {
        method: "GET",
        headers: target.headers,
        signal: controller.signal,
      })
      if (!response?.ok) throw new Error(`/stats returned HTTP ${response?.status ?? "unknown"}`)
      const fields = parseStatsPayload(await response.text())
      if (stopped) return false

      const sample = { ...fields, sampledAt: now() }
      const rate = calculateDecodeRate(previous, sample)
      previous = sample
      emit({ status: "online", rate, requestsInflight: sample.requestsInflight })
      return true
    } catch {
      if (!stopped) {
        previous = undefined
        emit({ status: "offline" })
      }
      return false
    } finally {
      if (requestTimer !== undefined) timers.clearTimeout(requestTimer)
      if (requestController === controller) requestController = undefined
      requestTimer = undefined
      active = false
    }
  }

  function start() {
    if (started || stopped) return
    started = true
    void poll()
    interval = timers.setInterval(() => void poll(), intervalMs)
    if (typeof interval?.unref === "function") interval.unref()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (interval !== undefined) timers.clearInterval(interval)
    if (requestTimer !== undefined) timers.clearTimeout(requestTimer)
    requestController?.abort()
    interval = undefined
    requestTimer = undefined
    requestController = undefined
    previous = undefined
  }

  return {
    poll,
    start,
    stop,
    get active() {
      return active
    },
  }
}

export function createDS4SpeedMeterServerPlugin(rawOptions = {}) {
  const options = serverOptions(rawOptions)
  const logger = rawOptions.logger ?? console

  return async () => {
    let warned = false

    function warnOnce(message) {
      if (warned) return
      warned = true
      logger.warn?.(`[opencode-ds4-speed-meter] ${message}`)
    }

    return {
      async config(config) {
        const provider = config.provider?.[options.providerID]
        if (!isRecord(provider)) {
          warnOnce(`provider ${options.providerID} is not configured; plugin disabled`)
          return
        }

        if (!isRecord(provider.options)) provider.options = {}
        const fetchImpl = typeof provider.options.fetch === "function" ? provider.options.fetch : globalThis.fetch
        try {
          await refreshDS4Limits(provider, fetchImpl, options.timeoutMs)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warnOnce(`dynamic limits unavailable (${message}); keeping configured fallback`)
        }
      },
    }
  }
}
