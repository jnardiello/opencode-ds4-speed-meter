import { Plugin } from "@opencode/plugin"

import { refreshProviderLimits, serverOptions } from "./ds4-speed-meter-core.mjs"

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Adapt a V2 Provider.Info (settings.baseURL/apiKey, headers) to the legacy
// provider shape the core helpers expect (options.baseURL/apiKey/headers).
function toLegacyProvider(info) {
  const record = isRecord(info) ? info : {}
  const settings = isRecord(record.settings) ? record.settings : {}
  const baseURL = typeof settings.baseURL === "string" ? settings.baseURL : undefined
  return {
    api: baseURL,
    options: {
      baseURL,
      apiKey: typeof settings.apiKey === "string" ? settings.apiKey : undefined,
      headers: isRecord(record.headers) ? record.headers : undefined,
    },
  }
}

export default Plugin.define({
  id: "local.opencode-speed-meter.server",
  async setup(ctx) {
    const options = serverOptions(ctx.options)
    const logger = console
    let warned = false
    const warnOnce = (message) => {
      if (warned) return
      warned = true
      logger.warn?.(`[opencode-speed-meter] ${message}`)
    }

    if (!options.providerID) {
      warnOnce("no providerID configured; dynamic limits refresh disabled")
      return
    }

    let info
    try {
      info = await ctx.provider.get({ providerID: options.providerID })
    } catch {
      info = undefined
    }
    if (!isRecord(info)) {
      warnOnce(`provider ${options.providerID} is not available; dynamic limits refresh disabled`)
      return
    }

    try {
      const applied = await refreshProviderLimits(toLegacyProvider(info), globalThis.fetch, options.timeoutMs)
      await ctx.provider.transform((editor) => {
        for (const { modelID, context, output } of applied) {
          editor.models.update(options.providerID, modelID, (model) => {
            if (context !== undefined) model.limit.context = context
            if (output !== undefined) model.limit.output = output
          })
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnOnce(`dynamic limits unavailable (${message}); keeping configured fallback`)
    }
  },
})
