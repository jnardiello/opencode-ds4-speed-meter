import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { createStatsPoller, statsTargets } from "../ds4-speed-meter-core.mjs"

export const DESCRIPTOR_INTERVAL_MS = 500

const DESCRIPTOR_FIELDS = new Set([
  "schemaVersion",
  "active",
  "source",
  "sessionId",
  "model",
  "provider",
  "baseURL",
  "statsURL",
  "statsPaths",
  "label",
  "intervalMs",
  "requestTimeoutMs",
  "windowMs",
  "updatedAt",
])

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value, name, { nonempty = false } = {}) {
  if (typeof value !== "string" || (nonempty && !value.trim())) {
    throw new Error(`${name} must be ${nonempty ? "a non-empty " : "a "}string`)
  }
  return nonempty ? value.trim() : value
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function httpURL(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`)
  }
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain credentials`)
  return parsed
}

function pollerOptions(descriptor) {
  return {
    intervalMs: descriptor.intervalMs,
    requestTimeoutMs: descriptor.requestTimeoutMs,
    windowMs: descriptor.windowMs,
    ...(descriptor.statsURL === null
      ? { statsPaths: descriptor.statsPaths }
      : { statsURL: descriptor.statsURL }),
  }
}

export function targetsForDescriptor(descriptor) {
  const targets = statsTargets(
    { options: { baseURL: descriptor.baseURL } },
    pollerOptions(descriptor),
  )
  for (const target of targets) {
    const parsed = httpURL(target.url, "telemetry URL")
    if (parsed.username || parsed.password) throw new Error("telemetry URL must not contain credentials")
  }
  return targets
}

export function parseRuntimeDescriptor(input) {
  let value = input
  if (typeof value === "string" || ArrayBuffer.isView(value)) {
    try {
      value = JSON.parse(String(value))
    } catch {
      throw new Error("runtime descriptor must be valid JSON")
    }
  }
  if (!isRecord(value)) throw new Error("runtime descriptor must be an object")
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_FIELDS.has(key)) throw new Error(`runtime descriptor contains unsupported field ${key}`)
  }
  if (value.schemaVersion !== 1) throw new Error("unsupported runtime descriptor schema")
  if (typeof value.active !== "boolean") throw new Error("active must be a boolean")
  if (!new Set(["override", "config", "request"]).has(value.source)) {
    throw new Error("source must be override, config, or request")
  }

  const descriptor = {
    schemaVersion: 1,
    active: value.active,
    source: value.source,
    sessionId: requiredString(value.sessionId, "sessionId"),
    model: requiredString(value.model, "model"),
    provider: requiredString(value.provider, "provider"),
    baseURL: requiredString(value.baseURL, "baseURL", { nonempty: true }),
    statsURL:
      value.statsURL === null
        ? null
        : requiredString(value.statsURL, "statsURL", { nonempty: true }),
    statsPaths: Array.isArray(value.statsPaths)
      ? value.statsPaths.map((path, index) =>
          requiredString(path, `statsPaths[${index}]`, { nonempty: true }),
        )
      : undefined,
    label: requiredString(value.label, "label", { nonempty: true }),
    intervalMs: positiveInteger(value.intervalMs, "intervalMs"),
    requestTimeoutMs: positiveInteger(value.requestTimeoutMs, "requestTimeoutMs"),
    windowMs: positiveInteger(value.windowMs, "windowMs"),
    updatedAt: value.updatedAt,
  }
  if (descriptor.statsPaths === undefined || descriptor.statsPaths.length === 0) {
    throw new Error("statsPaths must be a non-empty array")
  }
  if (typeof descriptor.updatedAt !== "number" || !Number.isFinite(descriptor.updatedAt) || descriptor.updatedAt < 0) {
    throw new Error("updatedAt must be a non-negative finite number")
  }

  httpURL(descriptor.baseURL, "baseURL")
  if (descriptor.statsURL !== null) httpURL(descriptor.statsURL, "statsURL")
  targetsForDescriptor(descriptor)
  return Object.freeze({ ...descriptor, statsPaths: Object.freeze([...descriptor.statsPaths]) })
}

export function runtimeDescriptorPath(environment = process.env, home = homedir()) {
  const hermesHome =
    typeof environment.HERMES_HOME === "string" && environment.HERMES_HOME.trim()
      ? environment.HERMES_HOME.trim()
      : join(home, ".hermes")
  return join(hermesHome, "plugin-data", "beast-telemetry", "runtime.json")
}

function defaultTimers() {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }
}

function fileSignature(stats) {
  return [stats.mtimeMs, stats.ctimeMs, stats.size, stats.ino].join(":")
}

function telemetryKey(descriptor, targets) {
  return JSON.stringify({
    targets: targets.map(({ url }) => url),
    intervalMs: descriptor.intervalMs,
    requestTimeoutMs: descriptor.requestTimeoutMs,
    windowMs: descriptor.windowMs,
  })
}

export function createBeastWidgetController(options = {}) {
  const fsImpl = options.fs ?? { readFile, stat }
  const timers = options.timers ?? defaultTimers()
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const makePoller = options.createPoller ?? createStatsPoller
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {}
  const descriptorPath = options.descriptorPath ?? runtimeDescriptorPath()
  const descriptorIntervalMs = options.descriptorIntervalMs ?? DESCRIPTOR_INTERVAL_MS

  if (typeof fsImpl.stat !== "function" || typeof fsImpl.readFile !== "function") {
    throw new Error("fs stat and readFile are required")
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  positiveInteger(descriptorIntervalMs, "descriptorIntervalMs")

  let state = Object.freeze({ visible: false, descriptor: undefined, metric: undefined })
  let descriptorTimer
  let lastSignature
  let readActive = false
  let started = false
  let stopped = false
  let currentPoller
  let currentKey
  let pollerGeneration = 0
  let hasSucceeded = false

  function publish(next) {
    if (stopped) return
    state = Object.freeze(next)
    try {
      onChange(state)
    } catch {
      // A rendering failure must not stop descriptor or telemetry polling.
    }
  }

  function stopPoller() {
    pollerGeneration += 1
    currentPoller?.stop()
    currentPoller = undefined
    currentKey = undefined
    hasSucceeded = false
  }

  function hide(descriptor) {
    stopPoller()
    if (state.visible || state.descriptor !== descriptor || state.metric !== undefined) {
      publish({ visible: false, descriptor, metric: undefined })
    }
  }

  function applyDescriptor(descriptor) {
    if (stopped) return
    if (descriptor === undefined || !descriptor.active) {
      hide(descriptor)
      return
    }

    let targets
    try {
      targets = targetsForDescriptor(descriptor)
    } catch {
      hide(undefined)
      return
    }
    const nextKey = telemetryKey(descriptor, targets)
    if (currentPoller !== undefined && currentKey === nextKey) {
      const explicit = descriptor.source === "override"
      publish({
        visible: explicit || hasSucceeded || state.metric?.status !== "offline",
        descriptor,
        metric: state.metric,
      })
      return
    }

    stopPoller()
    currentKey = nextKey
    const generation = pollerGeneration
    publish({ visible: true, descriptor, metric: { status: "loading" } })

    try {
      currentPoller = makePoller({
        intervalMs: descriptor.intervalMs,
        requestTimeoutMs: descriptor.requestTimeoutMs,
        windowMs: descriptor.windowMs,
        timers,
        fetchImpl,
        getTargets: () => targets,
        onUpdate(metric) {
          if (stopped || generation !== pollerGeneration) return
          if (metric?.status === "online") hasSucceeded = true
          const activeDescriptor = state.descriptor ?? descriptor
          const explicit = activeDescriptor.source === "override"
          publish({
            visible: metric?.status === "online" || explicit || hasSucceeded,
            descriptor: activeDescriptor,
            metric,
          })
        },
      })
      currentPoller.start()
    } catch {
      currentPoller = undefined
      const explicit = descriptor.source === "override"
      publish({ visible: explicit, descriptor, metric: { status: "offline" } })
    }
  }

  async function refreshDescriptor() {
    if (stopped || readActive) return false
    readActive = true
    try {
      let stats
      try {
        stats = await fsImpl.stat(descriptorPath)
      } catch {
        if (lastSignature !== null) {
          lastSignature = null
          applyDescriptor(undefined)
        }
        return false
      }

      const signature = fileSignature(stats)
      if (signature === lastSignature) return true
      lastSignature = signature

      try {
        const contents = await fsImpl.readFile(descriptorPath, "utf8")
        applyDescriptor(parseRuntimeDescriptor(contents))
        return true
      } catch {
        applyDescriptor(undefined)
        return false
      }
    } finally {
      readActive = false
    }
  }

  function start() {
    if (started || stopped) return
    started = true
    void refreshDescriptor()
    descriptorTimer = timers.setInterval(() => void refreshDescriptor(), descriptorIntervalMs)
    if (typeof descriptorTimer?.unref === "function") descriptorTimer.unref()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (descriptorTimer !== undefined) timers.clearInterval(descriptorTimer)
    descriptorTimer = undefined
    stopPoller()
  }

  return {
    descriptorPath,
    refreshDescriptor,
    start,
    stop,
    snapshot: () => state,
  }
}
