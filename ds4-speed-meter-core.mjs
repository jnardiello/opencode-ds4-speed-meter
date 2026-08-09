const DEFAULT_PROVIDER_ID = "ds4"
const DEFAULT_MODELS_TIMEOUT_MS = 2_000
const DEFAULT_STATS_INTERVAL_MS = 2_000
const DEFAULT_STATS_TIMEOUT_MS = 1_500
const DEFAULT_STATS_PATHS = Object.freeze(["stats", "../metrics"])
const DEFAULT_LABEL = "DS4"

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
  if (typeof raw !== "string" || !raw.trim()) throw new Error("provider has no baseURL")
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

function optionOptionalString(options, key) {
  const value = options?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionOptionalStringArray(options, key) {
  if (!Object.prototype.hasOwnProperty.call(options ?? {}, key)) return
  const value = options[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array of paths`)
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${key} must contain only non-empty string paths`)
    }
    return item.trim()
  })
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
  const statsURL = optionOptionalString(options, "statsURL")
  const statsPath = statsURL === undefined ? optionOptionalString(options, "statsPath") : undefined
  const statsPaths =
    statsURL === undefined && statsPath === undefined
      ? (optionOptionalStringArray(options, "statsPaths") ?? [...DEFAULT_STATS_PATHS])
      : undefined
  return {
    providerID: optionString(options, "providerID", DEFAULT_PROVIDER_ID),
    label: optionString(options, "label", DEFAULT_LABEL),
    statsPath,
    statsPaths,
    statsURL,
    intervalMs: optionPositiveInteger(options, "intervalMs", DEFAULT_STATS_INTERVAL_MS),
    requestTimeoutMs: optionPositiveInteger(options, "requestTimeoutMs", DEFAULT_STATS_TIMEOUT_MS),
  }
}

function statsBaseURL(provider) {
  let baseURL
  try {
    baseURL = new URL(providerBaseURL(provider))
  } catch {
    throw new Error("provider baseURL must be an absolute URL")
  }
  if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
    throw new Error("provider baseURL must use http or https")
  }

  baseURL.pathname = `${baseURL.pathname.replace(/\/+$/, "")}/`
  baseURL.hash = ""
  return baseURL
}

function sameOriginStatsURL(value, baseURL, optionName, absolute = false) {
  let parsed
  try {
    parsed = absolute ? new URL(value) : new URL(value, baseURL)
  } catch {
    throw new Error(
      absolute
        ? `${optionName} must be an absolute URL`
        : `provider baseURL and ${optionName} do not form a valid URL`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${optionName} must use http or https`)
  }
  if (parsed.origin !== baseURL.origin) {
    throw new Error(
      absolute
        ? `${optionName} must have the same origin as the provider baseURL`
        : `${optionName} must resolve to the provider baseURL origin`,
    )
  }
  parsed.hash = ""
  return parsed.toString()
}

function statsEndpointURLs(provider, options) {
  const baseURL = statsBaseURL(provider)
  const normalized = tuiOptions(options)

  if (normalized.statsURL !== undefined) {
    return [sameOriginStatsURL(normalized.statsURL, baseURL, "statsURL", true)]
  }

  const paths = normalized.statsPath === undefined ? normalized.statsPaths : [normalized.statsPath]
  const urls = []
  const seen = new Set()
  for (const path of paths) {
    const url = sameOriginStatsURL(path, baseURL, normalized.statsPath === undefined ? "statsPaths" : "statsPath")
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

export function statsTargets(provider, options = {}) {
  const urls = statsEndpointURLs(provider, options)
  const headers = configuredHeaders(provider)
  headers.set(
    "accept",
    "application/json, application/openmetrics-text; version=1.0.0; q=0.9, text/plain; version=0.0.4; q=0.8",
  )
  return urls.map((url) => ({ url, headers: new Headers(headers) }))
}

// Kept for callers that only need the first configured endpoint.
export function statsTarget(provider, options = {}) {
  return statsTargets(provider, options)[0]
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

const PROMETHEUS_TOKEN_METRICS = new Set([
  "vllm:generation_tokens_total",
  "vllm_generation_tokens_total",
])
const PROMETHEUS_RUNNING_METRICS = new Set([
  "vllm:num_requests_running",
  "vllm_num_requests_running",
])
const PROMETHEUS_WAITING_METRICS = new Set([
  "vllm:num_requests_waiting",
  "vllm_num_requests_waiting",
])

function prometheusSample(line) {
  const nameMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/)
  if (!nameMatch) return

  let index = nameMatch[0].length
  if (line[index] === "{") {
    let quoted = false
    let escaped = false
    let closed = false
    for (index += 1; index < line.length; index += 1) {
      const character = line[index]
      if (escaped) {
        escaped = false
      } else if (quoted && character === "\\") {
        escaped = true
      } else if (character === '"') {
        quoted = !quoted
      } else if (!quoted && character === "}") {
        index += 1
        closed = true
        break
      }
    }
    if (!closed) return
  }

  if (!/\s/.test(line[index] ?? "")) return
  while (/\s/.test(line[index] ?? "")) index += 1
  const rawValue = line.slice(index).match(/^[^\s#]+/)?.[0]
  if (rawValue === undefined) return
  return { name: nameMatch[1], value: Number(rawValue) }
}

function parsePrometheusStats(text) {
  let tokensDecoded = 0
  let requestsRunning = 0
  let requestsWaiting = 0
  let tokenSamples = 0
  let requestSamples = 0

  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue

    const parsed = prometheusSample(value)
    if (!parsed) continue
    const { name, value: sample } = parsed
    if (nonnegativeNumber(sample) === undefined) continue

    if (PROMETHEUS_TOKEN_METRICS.has(name)) {
      tokensDecoded += sample
      tokenSamples += 1
    } else if (PROMETHEUS_RUNNING_METRICS.has(name)) {
      requestsRunning += sample
      requestSamples += 1
    } else if (PROMETHEUS_WAITING_METRICS.has(name)) {
      requestsWaiting += sample
      requestSamples += 1
    }
  }

  const requestsInflight = requestsRunning + requestsWaiting
  if (
    tokenSamples === 0 ||
    requestSamples === 0 ||
    nonnegativeNumber(tokensDecoded) === undefined ||
    nonnegativeInteger(requestsInflight) === undefined
  ) {
    throw new Error("stats endpoint returned an invalid Prometheus payload")
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
    try {
      return parseTextStats(text)
    } catch {
      return parsePrometheusStats(text)
    }
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
  if (typeof options?.getTargets !== "function" && typeof options?.getTarget !== "function") {
    throw new Error("getTargets is required")
  }
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
  let preferredTargetURL
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

  function currentTargets() {
    const value = typeof options.getTargets === "function" ? options.getTargets() : options.getTarget()
    const candidates = Array.isArray(value) ? value : value ? [value] : []
    const targets = []
    const seen = new Set()
    for (const target of candidates) {
      if (!target || typeof target.url !== "string" || !target.url || seen.has(target.url)) continue
      seen.add(target.url)
      targets.push(target)
    }
    if (preferredTargetURL === undefined) return targets
    const preferredIndex = targets.findIndex((target) => target.url === preferredTargetURL)
    if (preferredIndex <= 0) return targets
    return [targets[preferredIndex], ...targets.slice(0, preferredIndex), ...targets.slice(preferredIndex + 1)]
  }

  async function fetchStats(target) {
    const controller = new AbortController()
    requestController = controller
    const timer = timers.setTimeout(() => controller.abort(), requestTimeoutMs)
    requestTimer = timer
    if (typeof timer?.unref === "function") timer.unref()

    try {
      const response = await options.fetchImpl(target.url, {
        method: "GET",
        headers: target.headers,
        redirect: "error",
        signal: controller.signal,
      })
      if (!response?.ok) throw new Error(`/stats returned HTTP ${response?.status ?? "unknown"}`)
      return parseStatsPayload(await response.text())
    } finally {
      if (requestTimer === timer) {
        timers.clearTimeout(timer)
        requestTimer = undefined
      }
      if (requestController === controller) requestController = undefined
    }
  }

  async function poll() {
    if (stopped || active) return false
    active = true

    try {
      const targets = currentTargets()
      if (targets.length === 0) {
        previous = undefined
        targetURL = undefined
        emit({ status: "offline" })
        return false
      }

      for (const target of targets) {
        let fields
        try {
          fields = await fetchStats(target)
        } catch {
          if (stopped) return false
          continue
        }
        if (stopped) return false

        if (targetURL !== target.url) {
          previous = undefined
          targetURL = target.url
        }
        preferredTargetURL = target.url

        const sample = { ...fields, sampledAt: now() }
        const rate = calculateDecodeRate(previous, sample)
        previous = sample
        emit({ status: "online", rate, requestsInflight: sample.requestsInflight })
        return true
      }

      previous = undefined
      if (!stopped) emit({ status: "offline" })
      return false
    } catch {
      previous = undefined
      if (!stopped) emit({ status: "offline" })
      return false
    } finally {
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
