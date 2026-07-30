import { Show, For, createSignal, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useBindings } from "../keymap"
import { useSDK } from "../context/sdk"

export type AdPreferencesProps = {
  dailySummary?: {
    adsSeen: number
    creditsEarned: number
    clickCount: number
  }
  availableCategories?: string[]
  onChange?: (prefs: AdPreferencesState) => void
}

export type AdPreferencesState = {
  adsEnabled: boolean
  allowedCategories: string[]
}

const KV_ADS_ENABLED = "codefree_ads_enabled"
const KV_AD_CATEGORIES = "codefree_ad_categories"
const ENGINE_CATEGORIES = [
  { value: "devtool", label: "Dev tools" },
  { value: "saas", label: "SaaS & cloud" },
  { value: "recruiting", label: "Recruiting" },
  { value: "education", label: "Education" },
  { value: "affiliate", label: "Affiliate offers" },
] as const
const DEFAULT_CATEGORIES = ENGINE_CATEGORIES.map((item) => item.value)

function toggleArrayItem(current: string[], item: string) {
  return current.includes(item) ? current.filter((c) => c !== item) : [...current, item]
}

export function AdPreferences(props: AdPreferencesProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const sdk = useSDK()

  const [adsEnabled, setAdsEnabled] = createSignal(kv.get(KV_ADS_ENABLED, false))
  const categories = () =>
    (props.availableCategories ?? DEFAULT_CATEGORIES).filter((category) =>
      DEFAULT_CATEGORIES.includes(category as (typeof DEFAULT_CATEGORIES)[number]),
    )
  const [allowedCategories, setAllowedCategories] = createSignal<string[]>(
    kv.get(KV_AD_CATEGORIES, categories()).filter((category: string) =>
      DEFAULT_CATEGORIES.includes(category as (typeof DEFAULT_CATEGORIES)[number]),
    ),
  )

  function syncPreferences(nextEnabled: boolean, nextCategories: string[]) {
    const directory = sdk.directory
    const suffix = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    void fetch(`${sdk.url}/codefree/preferences${suffix}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled, categories: nextCategories }),
    }).catch(() => {})
  }

  function toggleAds() {
    const next = !adsEnabled()
    setAdsEnabled(next)
    kv.set(KV_ADS_ENABLED, next)
    syncPreferences(next, allowedCategories())
    props.onChange?.({ adsEnabled: next, allowedCategories: allowedCategories() })
  }

  function toggleCategory(category: string) {
    const next = toggleArrayItem(allowedCategories(), category)
    setAllowedCategories(next)
    kv.set(KV_AD_CATEGORIES, next)
    syncPreferences(adsEnabled(), next)
    props.onChange?.({ adsEnabled: adsEnabled(), allowedCategories: next })
  }

  onMount(() => {
    const directory = sdk.directory
    const suffix = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    void fetch(`${sdk.url}/codefree/wallet/summary${suffix}`)
      .then((response) => response.json())
      .then((summary: { enabled?: boolean; categories?: string[] }) => {
        if (typeof summary.enabled === "boolean") {
          setAdsEnabled(summary.enabled)
          kv.set(KV_ADS_ENABLED, summary.enabled)
        }
      })
      .catch(() => {})
  })

  useBindings(() => ({
    bindings: [
      {
        key: "t",
        desc: "Toggle ads on/off",
        group: "AdPreferences",
        cmd: toggleAds,
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Ad Preferences
      </text>

      {/* Toggle */}
      <box flexDirection="row" gap={2} paddingTop={1}>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={adsEnabled() ? theme.success : theme.textMuted}
          onMouseUp={toggleAds}
        >
          <text fg={adsEnabled() ? theme.backgroundPanel : theme.text}>
            {adsEnabled() ? "ON" : "OFF"}
          </text>
        </box>
        <text fg={theme.text}>
          Show ads{adsEnabled() ? "" : " (ads disabled)"}
        </text>
        <text fg={theme.textMuted}>[t]</text>
      </box>

      {/* Daily summary */}
      <Show when={props.dailySummary}>
        {(summary) => (
          <box gap={1} paddingTop={1}>
            <text fg={theme.textMuted}>Today</text>
            <box flexDirection="row" gap={2}>
              <text fg={theme.text}>
                {summary().adsSeen} ads seen
              </text>
              <text fg={theme.success}>
                {summary().creditsEarned} credits earned
              </text>
              <Show when={summary().clickCount > 0}>
                <text fg={theme.text}>
                  {summary().clickCount} clicks
                </text>
              </Show>
            </box>
          </box>
        )}
      </Show>

      {/* Category preferences */}
      <Show when={adsEnabled()}>
        <box gap={1} paddingTop={1}>
          <text fg={theme.textMuted}>Categories</text>
          <For each={ENGINE_CATEGORIES}>
            {(category) => {
              const active = () => allowedCategories().includes(category.value)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.backgroundPanel : undefined}
                  onMouseUp={() => toggleCategory(category.value)}
                >
                  <text fg={active() ? theme.success : theme.textMuted}>
                    {active() ? "✓" : "○"}
                  </text>
                  <text fg={active() ? theme.text : theme.textMuted}>
                    {category.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
