import assert from "node:assert/strict"
import test from "node:test"

import {
  BEAST_WIDGET_KEY,
  createBeastTelemetryLifecycle,
  loadPiOptions,
  modelSupportsTelemetry,
  piOptions,
  resolveStatsSelection,
  statsTargetsForModel,
  widgetLines,
} from "./pi-beast-telemetry.mjs"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fakePi() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
    },
  }
}

function model(provider = "beast", id = "model", baseUrl = "http://127.0.0.1:8000/v1/") {
  return {
    id,
    provider,
    baseUrl,
    headers: { "x-model-header": id },
  }
}

function fakeContext({ currentModel = model(), mode = "tui", resolveAuth } = {}) {
  const widgets = []
  const notifications = []
  const authCalls = []
  return {
    authCalls,
    notifications,
    widgets,
    context: {
      mode,
      model: currentModel,
      modelRegistry: {
        async getApiKeyAndHeaders(value) {
          authCalls.push(value)
          return resolveAuth ? resolveAuth(value) : { ok: true, apiKey: "secret" }
        },
      },
      ui: {
        notify(...args) {
          notifications.push(args)
        },
        setWidget(...args) {
          widgets.push(args)
        },
      },
    },
  }
}

function fakePollers() {
  const instances = []
  function createPoller(options) {
    const instance = {
      options,
      starts: 0,
      stops: 0,
      emit(value) {
        options.onUpdate(value)
      },
      start() {
        this.starts += 1
      },
      stop() {
        this.stops += 1
      },
    }
    instances.push(instance)
    return instance
  }
  return { createPoller, instances }
}

const validConfig = JSON.stringify({})

test("normalizes Pi defaults and validates persistent configuration", async () => {
  assert.deepEqual(piOptions(), {
    label: "Beast",
    providerIDs: ["beast", "ds4", "vllm"],
    statsPaths: ["stats", "../metrics"],
    intervalMs: 2_000,
    requestTimeoutMs: 1_500,
    windowMs: 6_000,
  })

  assert.deepEqual(
    piOptions({
      label: "Local",
      providerIDs: ["local"],
      statsPaths: ["../metrics"],
      statsURL: " http://127.0.0.1:9000/metrics ",
      intervalMs: 3_000,
      requestTimeoutMs: 700,
      windowMs: 9_000,
    }),
    {
      label: "Local",
      providerIDs: ["local"],
      statsPaths: ["../metrics"],
      statsURL: "http://127.0.0.1:9000/metrics",
      intervalMs: 3_000,
      requestTimeoutMs: 700,
      windowMs: 9_000,
    },
  )

  assert.deepEqual(
    await loadPiOptions("/agent/extensions/beast-telemetry.json", async () => {
      const error = new Error("missing")
      error.code = "ENOENT"
      throw error
    }),
    piOptions(),
  )
  await assert.rejects(
    loadPiOptions("/agent/extensions/beast-telemetry.json", async () => "{"),
    /cannot parse/,
  )
  await assert.rejects(
    loadPiOptions("/agent/extensions/beast-telemetry.json", async () => '{"intervalMs":0}'),
    /intervalMs must be a positive integer/,
  )
})

test("applies flag, config, and model precedence and explicit override allowlisting", () => {
  const options = piOptions({ statsURL: "http://127.0.0.1:8000/config-metrics" })
  assert.deepEqual(resolveStatsSelection("http://127.0.0.1:8000/flag-metrics", options), {
    source: "flag",
    statsURL: "http://127.0.0.1:8000/flag-metrics",
  })
  assert.deepEqual(resolveStatsSelection(undefined, options), {
    source: "config",
    statsURL: "http://127.0.0.1:8000/config-metrics",
  })
  assert.deepEqual(resolveStatsSelection(undefined, piOptions()), {
    source: "model",
    statsPaths: ["stats", "../metrics"],
  })

  const automatic = resolveStatsSelection(undefined, piOptions())
  assert.equal(modelSupportsTelemetry(model("beast"), piOptions(), automatic), true)
  assert.equal(modelSupportsTelemetry(model("unknown"), piOptions(), automatic), false)
  assert.equal(
    modelSupportsTelemetry(
      model("unknown"),
      piOptions(),
      resolveStatsSelection("http://127.0.0.1:8000/metrics", piOptions()),
    ),
    true,
  )
  assert.equal(modelSupportsTelemetry(model("unknown"), options, resolveStatsSelection(undefined, options)), true)
})

test("maps Pi model auth to same-origin core stats targets", () => {
  const currentModel = model("beast", "deepseek", "http://127.0.0.1:8000/v1/")
  const targets = statsTargetsForModel(
    currentModel,
    {
      ok: true,
      apiKey: "secret",
      headers: { "x-auth-header": "resolved" },
    },
    resolveStatsSelection(undefined, piOptions()),
  )

  assert.deepEqual(
    targets.map((target) => target.url),
    ["http://127.0.0.1:8000/v1/stats", "http://127.0.0.1:8000/metrics"],
  )
  for (const target of targets) {
    assert.equal(target.headers.get("authorization"), "Bearer secret")
    assert.equal(target.headers.get("x-auth-header"), "resolved")
    assert.equal(target.headers.get("x-model-header"), "deepseek")
  }

  assert.deepEqual(
    statsTargetsForModel(currentModel, { ok: true }, {
      source: "flag",
      statsURL: "http://127.0.0.1:8000/custom-metrics",
    }).map((target) => target.url),
    ["http://127.0.0.1:8000/custom-metrics"],
  )
  assert.throws(
    () =>
      statsTargetsForModel(currentModel, { ok: true }, {
        source: "flag",
        statsURL: "http://telemetry.example.test/metrics",
      }),
    /same origin/,
  )
})

test("renders the Pi widget as the core meter's two aligned lines", () => {
  assert.deepEqual(widgetLines("Beast", { status: "loading" }), [
    "Beast  LOADING · P — · D — tok/s",
    "       Req — · KV — · DS —",
  ])
})

test("starts a TUI-only poller, updates the widget, and cleans up idempotently", async () => {
  const pi = fakePi()
  const pollers = fakePollers()
  const host = fakeContext()
  let configReads = 0
  const lifecycle = createBeastTelemetryLifecycle(pi, {
    configPath: "/agent/extensions/beast-telemetry.json",
    readFileImpl: async () => {
      configReads += 1
      return validConfig
    },
    fetchImpl: async () => new Response(),
    createPoller: pollers.createPoller,
  })

  assert.equal(await pi.handlers.get("session_start")({ type: "session_start" }, host.context), true)
  assert.equal(configReads, 1)
  assert.deepEqual(host.authCalls, [host.context.model])
  assert.equal(pollers.instances.length, 1)
  assert.equal(pollers.instances[0].starts, 1)
  assert.equal(pollers.instances[0].options.intervalMs, 2_000)
  assert.equal(pollers.instances[0].options.requestTimeoutMs, 1_500)
  assert.equal(pollers.instances[0].options.windowMs, 6_000)
  assert.deepEqual(host.widgets[0], [
    BEAST_WIDGET_KEY,
    ["Beast  LOADING · P — · D — tok/s", "       Req — · KV — · DS —"],
    { placement: "aboveEditor" },
  ])

  pollers.instances[0].emit({ status: "offline" })
  assert.deepEqual(host.widgets.at(-1)[1], [
    "Beast  OFFLINE · P — · D — tok/s",
    "       Req — · KV — · DS —",
  ])

  pi.handlers.get("session_shutdown")({ type: "session_shutdown" }, host.context)
  pi.handlers.get("session_shutdown")({ type: "session_shutdown" }, host.context)
  assert.equal(pollers.instances[0].stops, 1)
  assert.equal(host.widgets.filter((entry) => entry[1] === undefined).length, 1)
  assert.equal(lifecycle.poller, undefined)
})

test("model selection stops the old poller immediately and ignores stale async configuration", async () => {
  const pi = fakePi()
  const pollers = fakePollers()
  const firstAuth = { ok: true, apiKey: "first" }
  const pendingSecondAuth = deferred()
  const thirdAuth = deferred()
  const firstModel = model("beast", "first")
  const secondModel = model("beast", "second")
  const thirdModel = model("beast", "third")
  const authByID = new Map([
    ["first", firstAuth],
    ["second", pendingSecondAuth.promise],
    ["third", thirdAuth.promise],
  ])
  const host = fakeContext({
    currentModel: firstModel,
    resolveAuth: (value) => authByID.get(value.id),
  })
  createBeastTelemetryLifecycle(pi, {
    configPath: "/agent/extensions/beast-telemetry.json",
    readFileImpl: async () => validConfig,
    fetchImpl: async () => new Response(),
    createPoller: pollers.createPoller,
  })

  await pi.handlers.get("session_start")({ type: "session_start" }, host.context)
  const firstPoller = pollers.instances[0]
  const selectSecond = pi.handlers.get("model_select")(
    { type: "model_select", model: secondModel },
    host.context,
  )
  assert.equal(firstPoller.stops, 1)

  await Promise.resolve()
  const selectThird = pi.handlers.get("model_select")(
    { type: "model_select", model: thirdModel },
    host.context,
  )
  thirdAuth.resolve({ ok: true, apiKey: "third" })
  assert.equal(await selectThird, true)
  assert.equal(pollers.instances.length, 2)
  assert.equal(pollers.instances[1].starts, 1)

  pendingSecondAuth.resolve({ ok: true, apiKey: "second" })
  assert.equal(await selectSecond, false)
  assert.equal(pollers.instances.length, 2)

  firstPoller.emit({ status: "offline" })
  assert.notDeepEqual(host.widgets.at(-1)[1], [
    "Beast  OFFLINE · P — · D — tok/s",
    "       Req — · KV — · DS —",
  ])
})

test("invalid configuration warns once, disables safely, and never polls", async () => {
  const pi = fakePi()
  const pollers = fakePollers()
  const host = fakeContext()
  let reads = 0
  const lifecycle = createBeastTelemetryLifecycle(pi, {
    configPath: "/agent/extensions/beast-telemetry.json",
    readFileImpl: async () => {
      reads += 1
      return '{"providerIDs":[]}'
    },
    fetchImpl: async () => new Response(),
    createPoller: pollers.createPoller,
  })

  assert.equal(await pi.handlers.get("session_start")({ type: "session_start" }, host.context), false)
  assert.equal(
    await pi.handlers.get("model_select")(
      { type: "model_select", model: model("beast", "next") },
      host.context,
    ),
    false,
  )
  assert.equal(lifecycle.disabled, true)
  assert.equal(reads, 1)
  assert.equal(host.notifications.length, 1)
  assert.match(host.notifications[0][0], /extension disabled/)
  assert.equal(host.notifications[0][1], "warning")
  assert.equal(host.authCalls.length, 0)
  assert.equal(pollers.instances.length, 0)
})

test("does no configuration, auth, widgets, or polling outside TUI mode", async () => {
  for (const mode of ["rpc", "json", "print"]) {
    const pi = fakePi()
    const pollers = fakePollers()
    const host = fakeContext({ mode })
    let reads = 0
    createBeastTelemetryLifecycle(pi, {
      configPath: "/agent/extensions/beast-telemetry.json",
      readFileImpl: async () => {
        reads += 1
        return validConfig
      },
      fetchImpl: async () => new Response(),
      createPoller: pollers.createPoller,
    })

    assert.equal(await pi.handlers.get("session_start")({ type: "session_start" }, host.context), false)
    assert.equal(
      await pi.handlers.get("model_select")(
        { type: "model_select", model: model("beast", "next") },
        host.context,
      ),
      false,
    )
    pi.handlers.get("session_shutdown")({ type: "session_shutdown" }, host.context)
    assert.equal(reads, 0)
    assert.equal(host.authCalls.length, 0)
    assert.equal(host.widgets.length, 0)
    assert.equal(host.notifications.length, 0)
    assert.equal(pollers.instances.length, 0)
  }
})
