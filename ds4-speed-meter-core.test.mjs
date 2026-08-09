import assert from "node:assert/strict"
import test from "node:test"

import {
  calculateDecodeRate,
  createDS4SpeedMeterServerPlugin,
  createStatsPoller,
  parseStatsPayload,
  refreshDS4Limits,
  statsTarget,
  statsTargets,
  tuiOptions,
} from "./ds4-speed-meter-core.mjs"

function modelResponse(context = 300_000, output = context) {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "deepseek-v4-flash",
          context_length: context,
          top_provider: { context_length: context, max_completion_tokens: output },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function config(fetchImpl, context = 100_000) {
  return {
    provider: {
      ds4: {
        options: {
          baseURL: "http://127.0.0.1:8000/v1/",
          apiKey: "test-key",
          fetch: fetchImpl,
        },
        models: {
          "deepseek-v4-flash": {
            limit: { context, output: context },
          },
        },
      },
    },
  }
}

const quiet = { info() {}, warn() {} }

test("updates configured limits from the DS4 model endpoint", async () => {
  const cfg = config(async () => modelResponse(300_000, 280_000))
  const applied = await refreshDS4Limits(cfg.provider.ds4, cfg.provider.ds4.options.fetch)

  assert.deepEqual(applied, [{ modelID: "deepseek-v4-flash", context: 300_000, output: 280_000 }])
  assert.deepEqual(cfg.provider.ds4.models["deepseek-v4-flash"].limit, {
    context: 300_000,
    output: 280_000,
  })
})

test("keeps configured limits when discovery fails", async () => {
  const warnings = []
  const cfg = config(async () => {
    throw new Error("offline")
  })
  const plugin = createDS4SpeedMeterServerPlugin({ logger: { ...quiet, warn: (value) => warnings.push(value) } })
  const hooks = await plugin({})

  await hooks.config(cfg)

  assert.equal(cfg.provider.ds4.models["deepseek-v4-flash"].limit.context, 100_000)
  assert.equal(warnings.length, 1)
})

test("builds the stats target from the configured provider", () => {
  const provider = config(async () => {}).provider.ds4
  const targets = statsTargets(provider)
  assert.deepEqual(
    targets.map((target) => target.url),
    ["http://127.0.0.1:8000/v1/stats", "http://127.0.0.1:8000/metrics"],
  )
  assert.equal(statsTarget(provider).url, targets[0].url)
  for (const target of targets) {
    assert.equal(target.headers.get("authorization"), "Bearer test-key")
    assert.match(target.headers.get("accept"), /application\/json/)
    assert.match(target.headers.get("accept"), /application\/openmetrics-text/)
    assert.match(target.headers.get("accept"), /text\/plain/)
  }

  assert.deepEqual(
    statsTargets(provider, { statsPath: "../metrics", statsPaths: ["stats", "../metrics"] }).map(
      (target) => target.url,
    ),
    ["http://127.0.0.1:8000/metrics"],
  )
  assert.deepEqual(
    statsTargets(provider, {
      statsPath: "/ignored",
      statsURL: "http://127.0.0.1:8000/custom-metrics",
    }).map((target) => target.url),
    ["http://127.0.0.1:8000/custom-metrics"],
  )
  assert.deepEqual(
    statsTargets(provider, {
      statsPaths: ["stats", "./stats", "../metrics", "http://127.0.0.1:8000/metrics#duplicate"],
    }).map((target) => target.url),
    ["http://127.0.0.1:8000/v1/stats", "http://127.0.0.1:8000/metrics"],
  )
  assert.throws(() => statsTarget(provider, { statsURL: "/metrics" }), /absolute URL/)
  assert.throws(
    () => statsTarget(provider, { statsURL: "https://telemetry.example.test/metrics" }),
    /same origin/,
  )
  assert.throws(
    () => statsTarget(provider, { statsPath: "https://telemetry.example.test/metrics" }),
    /provider baseURL origin/,
  )
  assert.throws(
    () => statsTargets(provider, { statsPaths: ["stats", "//telemetry.example.test/metrics"] }),
    /provider baseURL origin/,
  )
  assert.throws(() => statsTargets(provider, { statsPaths: [] }), /non-empty array/)
  assert.throws(() => statsTargets(provider, { statsPaths: ["stats", " "] }), /non-empty string paths/)
  assert.throws(() => statsTargets(provider, { statsPaths: "stats" }), /non-empty array/)
})

test("parses nested JSON and Entrpi text stats", () => {
  assert.deepEqual(
    parseStatsPayload({
      server: { context: 300_000, requests_inflight: 2 },
      serving: { tokens_decoded: 4_294_967_400 },
    }),
    { tokensDecoded: 4_294_967_400, requestsInflight: 2 },
  )

  assert.deepEqual(
    parseStatsPayload(`# Server
requests_inflight:1

# Serving
tokens_decoded:7112
decode_tok_s_60s:4.07
`),
    { tokensDecoded: 7_112, requestsInflight: 1 },
  )
  assert.deepEqual(
    parseStatsPayload('{"server":{"requests_inflight":0},"serving":{"tokens_decoded":9}}'),
    { tokensDecoded: 9, requestsInflight: 0 },
  )
  assert.throws(() => parseStatsPayload("requests_inflight:0"), /invalid Prometheus payload/)
})

test("parses and aggregates vLLM Prometheus token and request metrics", () => {
  assert.deepEqual(
    parseStatsPayload(`vllm:num_requests_running{engine="0",model_name="deepseek-v4-flash"} 0.0
vllm:num_requests_waiting{engine="0",model_name="deepseek-v4-flash"} 0.0
vllm:num_requests_waiting_by_reason{engine="0",model_name="deepseek-v4-flash",reason="capacity"} 0.0
vllm:generation_tokens_total{engine="0",model_name="deepseek-v4-flash"} 830.0
`),
    { tokensDecoded: 830, requestsInflight: 0 },
  )

  assert.deepEqual(
    parseStatsPayload(`# HELP vllm:generation_tokens_total Number of generated tokens.
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{model_name="deepseek } one",engine="0"} 1.2e3 # {trace_id="abc"} 1
vllm:generation_tokens_total{model_name="deepseek",engine="1"} 300 1720000000000
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="deepseek",engine="0"} 2
vllm:num_requests_running{model_name="deepseek",engine="1"} 1
vllm:num_requests_waiting{model_name="deepseek",engine="0"} 4
irrelevant_metric 999
`),
    { tokensDecoded: 1_500, requestsInflight: 7 },
  )

  assert.deepEqual(
    parseStatsPayload(`vllm_generation_tokens_total 42
vllm_num_requests_running 0
`),
    { tokensDecoded: 42, requestsInflight: 0 },
  )
  assert.throws(() => parseStatsPayload("vllm:generation_tokens_total 42"), /invalid Prometheus payload/)
})

test("calculates an interval decode rate through completion and handles idle or reset samples", () => {
  const previous = { tokensDecoded: 100, requestsInflight: 1, sampledAt: 1_000 }
  assert.equal(
    calculateDecodeRate(previous, { tokensDecoded: 130, requestsInflight: 1, sampledAt: 3_000 }),
    15,
  )
  assert.equal(
    calculateDecodeRate(previous, { tokensDecoded: 130, requestsInflight: 0, sampledAt: 3_000 }),
    15,
  )
  assert.equal(
    calculateDecodeRate(previous, { tokensDecoded: 100, requestsInflight: 0, sampledAt: 3_000 }),
    0,
  )
  assert.equal(
    calculateDecodeRate(previous, { tokensDecoded: 4, requestsInflight: 1, sampledAt: 3_000 }),
    0,
  )
  assert.equal(calculateDecodeRate(undefined, previous), 0)
})

test("normalizes TUI defaults and explicit polling options", () => {
  assert.deepEqual(tuiOptions(), {
    providerID: "ds4",
    label: "DS4",
    statsPath: undefined,
    statsPaths: ["stats", "../metrics"],
    statsURL: undefined,
    intervalMs: 2_000,
    requestTimeoutMs: 1_500,
  })
  assert.deepEqual(
    tuiOptions({
      providerID: "local",
      label: "Beast",
      statsPath: "../metrics",
      statsPaths: ["ignored"],
      statsURL: "https://beast.example.test/metrics",
      intervalMs: 5_000,
      requestTimeoutMs: 800,
    }),
    {
      providerID: "local",
      label: "Beast",
      statsPath: undefined,
      statsPaths: undefined,
      statsURL: "https://beast.example.test/metrics",
      intervalMs: 5_000,
      requestTimeoutMs: 800,
    },
  )
  assert.deepEqual(tuiOptions({ statsPath: "../metrics", statsPaths: ["ignored"] }), {
    providerID: "ds4",
    label: "DS4",
    statsPath: "../metrics",
    statsPaths: undefined,
    statsURL: undefined,
    intervalMs: 2_000,
    requestTimeoutMs: 1_500,
  })
})

function manualTimers() {
  let intervalCallback
  let intervalCleared = false
  let timeoutCallback
  let timeoutCleared = false
  return {
    api: {
      setInterval(callback) {
        intervalCallback = callback
        return 11
      },
      clearInterval(id) {
        assert.equal(id, 11)
        intervalCleared = true
      },
      setTimeout(callback) {
        timeoutCallback = callback
        return 12
      },
      clearTimeout(id) {
        assert.equal(id, 12)
        timeoutCleared = true
      },
    },
    interval() {
      intervalCallback?.()
    },
    timeout() {
      timeoutCallback?.()
    },
    get intervalCleared() {
      return intervalCleared
    },
    get timeoutCleared() {
      return timeoutCleared
    },
  }
}

test("poller takes an immediate baseline, updates the rate, and cleans up", async () => {
  const timers = manualTimers()
  const updates = []
  const payloads = [
    { server: { requests_inflight: 1 }, serving: { tokens_decoded: 100 } },
    { server: { requests_inflight: 1 }, serving: { tokens_decoded: 140 } },
  ]
  const times = [1_000, 3_000]
  let calls = 0
  const poller = createStatsPoller({
    intervalMs: 2_000,
    requestTimeoutMs: 1_500,
    timers: timers.api,
    now: () => times.shift(),
    getTarget: () => ({ url: "http://127.0.0.1:8000/v1/stats" }),
    fetchImpl: async () =>
      new Response(JSON.stringify(payloads[calls++]), { headers: { "content-type": "application/json" } }),
    onUpdate: (value) => updates.push(value),
  })

  assert.equal(await poller.poll(), true)
  assert.equal(await poller.poll(), true)
  assert.deepEqual(updates, [
    { status: "online", rate: 0, requestsInflight: 1 },
    { status: "online", rate: 20, requestsInflight: 1 },
  ])

  poller.start()
  poller.stop()
  assert.equal(timers.intervalCleared, true)
  assert.equal(timers.timeoutCleared, true)
})

test("poller falls back to metrics once and caches the successful endpoint", async () => {
  const provider = config(async () => {}).provider.ds4
  const targets = statsTargets(provider)
  const requested = []
  const updates = []
  const times = [1_000, 3_000]
  const metrics = [
    `vllm:generation_tokens_total 100
vllm:num_requests_running 1
vllm:num_requests_waiting 0
`,
    `vllm:generation_tokens_total 140
vllm:num_requests_running 1
vllm:num_requests_waiting 0
`,
  ]
  const poller = createStatsPoller({
    now: () => times.shift(),
    getTargets: () => targets,
    fetchImpl: async (url, init) => {
      requested.push(url)
      assert.equal(init.redirect, "error")
      assert.equal(init.headers.get("authorization"), "Bearer test-key")
      if (url.endsWith("/v1/stats")) return new Response("not found", { status: 404 })
      return new Response(metrics.shift(), { headers: { "content-type": "text/plain" } })
    },
    onUpdate: (value) => updates.push(value),
  })

  assert.equal(await poller.poll(), true)
  assert.equal(await poller.poll(), true)
  assert.deepEqual(requested, [
    "http://127.0.0.1:8000/v1/stats",
    "http://127.0.0.1:8000/metrics",
    "http://127.0.0.1:8000/metrics",
  ])
  assert.deepEqual(updates, [
    { status: "online", rate: 0, requestsInflight: 1 },
    { status: "online", rate: 20, requestsInflight: 1 },
  ])
  poller.stop()
})

test("poller changes preference after failure and can switch back", async () => {
  const targets = statsTargets(config(async () => {}).provider.ds4)
  const requested = []
  const updates = []
  const times = [1_000, 2_000, 3_000, 4_000]
  const responses = [
    ["/v1/stats", '{"server":{"requests_inflight":1},"serving":{"tokens_decoded":10}}', 200],
    ["/v1/stats", "unavailable", 503],
    ["/metrics", "vllm:generation_tokens_total 20\nvllm:num_requests_running 1\n", 200],
    ["/metrics", "unavailable", 503],
    ["/v1/stats", "requests_inflight:1\ntokens_decoded:30\n", 200],
    ["/v1/stats", "requests_inflight:1\ntokens_decoded:40\n", 200],
  ]
  const poller = createStatsPoller({
    now: () => times.shift(),
    getTargets: () => targets,
    fetchImpl: async (url) => {
      requested.push(new URL(url).pathname)
      const [expectedPath, body, status] = responses.shift()
      assert.equal(new URL(url).pathname, expectedPath)
      return new Response(body, { status })
    },
    onUpdate: (value) => updates.push(value),
  })

  assert.equal(await poller.poll(), true)
  assert.equal(await poller.poll(), true)
  assert.equal(await poller.poll(), true)
  assert.equal(await poller.poll(), true)
  assert.deepEqual(requested, [
    "/v1/stats",
    "/v1/stats",
    "/metrics",
    "/metrics",
    "/v1/stats",
    "/v1/stats",
  ])
  assert.deepEqual(updates, [
    { status: "online", rate: 0, requestsInflight: 1 },
    { status: "online", rate: 0, requestsInflight: 1 },
    { status: "online", rate: 0, requestsInflight: 1 },
    { status: "online", rate: 10, requestsInflight: 1 },
  ])
  poller.stop()
})

test("poller never overlaps requests and aborts an active fetch on stop", async () => {
  const timers = manualTimers()
  let calls = 0
  let resolveFetch
  let capturedSignal
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve
  })
  const poller = createStatsPoller({
    timers: timers.api,
    getTarget: () => ({ url: "http://127.0.0.1:8000/v1/stats" }),
    fetchImpl: async (_url, init) => {
      calls += 1
      capturedSignal = init.signal
      return fetchPromise
    },
    onUpdate() {},
  })

  const first = poller.poll()
  assert.equal(await poller.poll(), false)
  assert.equal(calls, 1)
  poller.stop()
  assert.equal(capturedSignal.aborted, true)
  resolveFetch(new Response("", { status: 503 }))
  assert.equal(await first, false)
})

test("poller reports offline for an unavailable endpoint", async () => {
  const updates = []
  const poller = createStatsPoller({
    getTarget: () => undefined,
    fetchImpl: async () => {
      throw new Error("must not be called")
    },
    onUpdate: (value) => updates.push(value),
  })

  assert.equal(await poller.poll(), false)
  assert.deepEqual(updates, [{ status: "offline" }])
  poller.stop()
})
