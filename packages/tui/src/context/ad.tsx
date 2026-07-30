import { createSignal } from "solid-js"
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"
import type { AdData, AdPlacement } from "../ui/ad-banner"

export type CurrentAd = AdData & {
  impression_id: string
  slot_min_ms: number
  session_id: string
  placement: AdPlacement
}

export const { use: useAd, provider: AdProvider } = createSimpleContext({
  name: "Ad",
  init: () => {
    const event = useEvent()
    const [currentAd, setCurrentAd] = createSignal<CurrentAd | null>(null)

    const unsubscribe = event.subscribe((evt) => {
      if ((evt.type as string) !== "codefree.ad.impression") return
      const properties = evt.properties as {
        impression_id?: string
        slot_min_ms?: number
        session_id?: string
        slot_type?: AdPlacement
        headline?: string
        body?: string
        cta_text?: string
        cta_url?: string
        display_url?: string
        category?: string
        ad_id?: string
      }
      if (!properties.impression_id || !properties.headline) return
      setCurrentAd({
        id: properties.ad_id ?? properties.impression_id,
        impression_id: properties.impression_id,
        slot_min_ms: properties.slot_min_ms ?? 8000,
        session_id: properties.session_id ?? "",
        placement: properties.slot_type ?? "thinking",
        headline: properties.headline,
        body: properties.body ?? "",
        cta: properties.cta_text ?? "Learn more",
        url: properties.cta_url ?? "",
        category: properties.category ?? "",
      })
    })
    onCleanup(unsubscribe)

    function dismissAd() {
      setCurrentAd(null)
    }

    return {
      currentAd,
      dismissAd,
    }
  },
})
