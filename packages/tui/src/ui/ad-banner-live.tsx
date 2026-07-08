import { Show, createMemo } from "solid-js"
import { useAd } from "../context/ad"
import { useSDK } from "../context/sdk"
import { AdBanner } from "./ad-banner"
import { useToast } from "./toast"

function codefreePath(sdk: { url: string; directory?: string }, path: string) {
  const suffix = sdk.directory ? `?directory=${encodeURIComponent(sdk.directory)}` : ""
  return `${sdk.url}${path}${suffix}`
}

export function AdBannerLive() {
  const ad = useAd()
  const sdk = useSDK()
  const toast = useToast()
  const current = createMemo(() => ad.currentAd())

  async function postClick(impressionId: string, clickUrl: string) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      await fetch(codefreePath(sdk, `/codefree/impression/${impressionId}/click`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ click_url: clickUrl }),
        signal: controller.signal,
      })
    } catch {
    } finally {
      clearTimeout(timeout)
    }
  }

  async function completeImpression(impressionId: string) {
    try {
      const response = await fetch(codefreePath(sdk, `/codefree/impression/${impressionId}/complete`), {
        method: "POST",
        headers: { "content-type": "application/json" },
      })
      const body = (await response.json()) as { credited?: boolean }
      if (body.credited) {
        toast.show({ message: "+4 credits", variant: "success", duration: 2000 })
      }
    } catch {
    }
  }

  return (
    <Show when={current()}>
      {(active) => (
        <AdBanner
          ad={{
            id: active().id,
            headline: active().headline,
            body: active().body,
            cta: active().cta,
            url: active().url,
            category: active().category,
          }}
          placement={active().placement}
          visible={true}
          durationMs={active().slot_min_ms}
          onDismiss={() => ad.dismissAd()}
          onCreditTimer={() => completeImpression(active().impression_id)}
          onClick={() => {
            void postClick(active().impression_id, active().url)
          }}
        />
      )}
    </Show>
  )
}
