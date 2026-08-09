import assert from "node:assert/strict"
import test from "node:test"

import register, { BEAST_WIDGET } from "./beast-meter.mjs"
import {
  createBeastWidgetController,
  parseRuntimeDescriptor,
  runtimeDescriptorPath,
  targetsForDescriptor,
} from "./widget-core.mjs"

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    active: true,
    source: "request",
    sessionId: "session-1",
    model: "beast/model",
    provider: "beast",
    baseURL: "http://127.0.0.1:8000/v1",
    statsURL: null,
    statsPaths: ["stats", "../metrics"],
    label: "Beast",
    intervalMs: 2_000,
    requestTimeoutMs: 1_500,
    windowMs: 6_000,
    updatedAt: 1,
    ...overrides,
  }
}

function fakeFile(initial = descriptor()) {
  let value = initial
  let version = 1
  return {
    fs: {
      async stat() {
        const text = JSON.stringify(value)
        return { mtimeMs: version, ctimeMs: version, size: text.length, ino: 7 }
      },
      async readFile() {
        return JSON.stringify(value)
      },
    },
    update(next) {
      value = next
      version += 1
    },
  }
}

function pollerHarness() {
  const pollers = []
  return {
    pollers,
    createPoller(options) {
      const poller = {
        options,
        starts: 0,
        stops: 0,
        start() {
          this.starts += 1
        },
        stop() {
          this.stops += 1
        },
      }
      pollers.push(poller)
      return poller
    },
  }
}

function controllerFor(file, harness, overrides = {}) {
  return createBeastWidgetController({
    descriptorPath: "/hermes/runtime.json",
    fs: file.fs,
    fetchImpl: async () => {
      throw new Error("fake pollers do not fetch")
    },
    createPoller: harness.createPoller,
    ...overrides,
  })
}

function fakeTimers() {
  let nextID = 1
  const intervals = new Map()
  const timeouts = new Map()
  return {
    intervals,
    timeouts,
    timers: {
      setInterval(callback, delay) {
        const token = { id: nextID++, callback, delay }
        intervals.set(token.id, token)
        return token
      },
      clearInterval(token) {
        intervals.delete(token?.id)
      },
      setTimeout(callback, delay) {
        const token = { id: nextID++, callback, delay }
        timeouts.set(token.id, token)
        return token
      },
      clearTimeout(token) {
        timeouts.delete(token?.id)
      },
    },
  }
}

test("Hermes registration publishes Beast metadata and auto-opens the ambient widget", () => {
  let definition
  let opened
  const sdk = {
    Box: "Box",
    Dialog: "Dialog",
    React: {},
    Text: "Text",
    h: () => null,
    defineWidgetApp(value) {
      definition = value
      return value
    },
    openWidget(app, state) {
      opened = { app, state }
    },
  }

  const app = register(sdk)
  assert.equal(app, definition)
  assert.deepEqual(
    {
      id: definition.id,
      name: definition.name,
      mode: definition.mode,
      zone: definition.zone,
      width: definition.width,
    },
    { id: "beast", name: "beast", mode: "ambient", zone: "dock-bottom", width: 50 },
  )
  assert.deepEqual(BEAST_WIDGET, {
    id: "beast",
    name: "beast",
    help: "live Beast / vLLM telemetry",
    mode: "ambient",
    zone: "dock-bottom",
    width: 50,
  })
  assert.equal(opened.app, app)
  assert.deepEqual(opened.state, {})
})

test("runtime descriptor path honors HERMES_HOME and falls back below the home directory", () => {
  assert.equal(
    runtimeDescriptorPath({ HERMES_HOME: "/opt/hermes" }, "/home/test"),
    "/opt/hermes/plugin-data/beast-telemetry/runtime.json",
  )
  assert.equal(
    runtimeDescriptorPath({}, "/home/test"),
    "/home/test/.hermes/plugin-data/beast-telemetry/runtime.json",
  )
})

test("descriptor validation permits only safe same-origin HTTP telemetry", () => {
  const parsed = parseRuntimeDescriptor(JSON.stringify(descriptor()))
  assert.equal(parsed.baseURL, "http://127.0.0.1:8000/v1")
  assert.deepEqual(
    targetsForDescriptor(parsed).map(({ url }) => url),
    ["http://127.0.0.1:8000/v1/stats", "http://127.0.0.1:8000/metrics"],
  )
  for (const target of targetsForDescriptor(parsed)) {
    assert.deepEqual([...target.headers.keys()], ["accept"])
  }

  assert.throws(() => parseRuntimeDescriptor(descriptor({ schemaVersion: 2 })), /unsupported.*schema/)
  assert.throws(() => parseRuntimeDescriptor(descriptor({ baseURL: "file:///tmp/v1" })), /http or https/)
  assert.throws(
    () => parseRuntimeDescriptor(descriptor({ baseURL: "https://token@example.test/v1" })),
    /credentials/,
  )
  assert.throws(
    () => parseRuntimeDescriptor(descriptor({ statsURL: "https://other.example.test/metrics" })),
    /same origin/,
  )
  assert.throws(
    () => parseRuntimeDescriptor({ ...descriptor(), headers: { authorization: "secret" } }),
    /unsupported field headers/,
  )
  assert.throws(() => parseRuntimeDescriptor("{"), /valid JSON/)
})

test("descriptor updates preserve a poller, while endpoint changes stop it and reset state", async () => {
  const file = fakeFile()
  const harness = pollerHarness()
  const controller = controllerFor(file, harness)

  assert.equal(await controller.refreshDescriptor(), true)
  assert.equal(harness.pollers.length, 1)
  assert.equal(harness.pollers[0].starts, 1)
  harness.pollers[0].options.onUpdate({ status: "online", rate: 4, requestsInflight: 1 })
  assert.equal(controller.snapshot().metric.status, "online")

  file.update(descriptor({ label: "GPU Beast", updatedAt: 2 }))
  await controller.refreshDescriptor()
  assert.equal(harness.pollers.length, 1)
  assert.equal(controller.snapshot().descriptor.label, "GPU Beast")
  assert.equal(controller.snapshot().metric.status, "online")

  file.update(descriptor({ statsURL: "http://127.0.0.1:8000/metrics", updatedAt: 3 }))
  await controller.refreshDescriptor()
  assert.equal(harness.pollers[0].stops, 1)
  assert.equal(harness.pollers.length, 2)
  assert.equal(harness.pollers[1].starts, 1)
  assert.deepEqual(controller.snapshot().metric, { status: "loading" })
  assert.equal(controller.snapshot().visible, true)
  controller.stop()
})

test("an automatic source hides after its first failed attempt", async () => {
  const file = fakeFile(descriptor({ source: "request" }))
  const harness = pollerHarness()
  const controller = controllerFor(file, harness)

  await controller.refreshDescriptor()
  assert.equal(controller.snapshot().visible, true)
  assert.deepEqual(controller.snapshot().metric, { status: "loading" })
  harness.pollers[0].options.onUpdate({ status: "offline" })
  assert.equal(controller.snapshot().visible, false)
  assert.deepEqual(controller.snapshot().metric, { status: "offline" })
  controller.stop()
})

test("an automatic source remains visible offline after at least one success", async () => {
  const file = fakeFile(descriptor({ source: "config" }))
  const harness = pollerHarness()
  const controller = controllerFor(file, harness)

  await controller.refreshDescriptor()
  harness.pollers[0].options.onUpdate({ status: "online", rate: 0, requestsInflight: 0 })
  harness.pollers[0].options.onUpdate({ status: "offline" })
  assert.equal(controller.snapshot().visible, true)
  assert.deepEqual(controller.snapshot().metric, { status: "offline" })
  controller.stop()
})

test("an explicit override always remains visible while offline", async () => {
  const file = fakeFile(descriptor({ source: "override" }))
  const harness = pollerHarness()
  const controller = controllerFor(file, harness)

  await controller.refreshDescriptor()
  harness.pollers[0].options.onUpdate({ status: "offline" })
  assert.equal(controller.snapshot().visible, true)
  assert.deepEqual(controller.snapshot().metric, { status: "offline" })
  controller.stop()
})

test("missing, inactive, and unsupported descriptors stop polling and stay hidden", async () => {
  const file = fakeFile()
  const harness = pollerHarness()
  const controller = controllerFor(file, harness)
  await controller.refreshDescriptor()

  file.update(descriptor({ active: false, updatedAt: 2 }))
  await controller.refreshDescriptor()
  assert.equal(harness.pollers[0].stops, 1)
  assert.equal(controller.snapshot().visible, false)

  file.update(descriptor({ active: true, schemaVersion: 9, updatedAt: 3 }))
  await controller.refreshDescriptor()
  assert.equal(controller.snapshot().visible, false)
  assert.equal(harness.pollers.length, 1)
  controller.stop()
})

test("stop clears the 500ms descriptor timer and aborts the active telemetry fetch", async () => {
  const file = fakeFile()
  const clock = fakeTimers()
  let requestSignal
  const controller = createBeastWidgetController({
    descriptorPath: "/hermes/runtime.json",
    fs: file.fs,
    timers: clock.timers,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal
      return await new Promise(() => {})
    },
  })

  await controller.refreshDescriptor()
  controller.start()
  assert.equal(requestSignal.aborted, false)
  assert.deepEqual(
    [...clock.intervals.values()].map(({ delay }) => delay).sort((left, right) => left - right),
    [500, 2_000],
  )

  controller.stop()
  assert.equal(requestSignal.aborted, true)
  assert.equal(clock.intervals.size, 0)
  assert.equal(clock.timeouts.size, 0)
})
