import { Show, For, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useBindings } from "../keymap"

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
const DEFAULT_CATEGORIES = ["devtools", "cloud", "education", "productivity", "open_source"]

function toggleArrayItem(current: string[], item: string) {
  return current.includes(item) ? current.filter((c) => c !== item) : [...current, item]
}

export function AdPreferences(props: AdPreferencesProps) {
  const { theme } = useTheme()
  const kv = useKV()

  const [adsEnabled, setAdsEnabled] = createSignal(kv.get(KV_ADS_ENABLED, false))
  const categories = () => (props.availableCategories ?? DEFAULT_CATEGORIES)
  const [allowedCategories, setAllowedCategories] = createSignal<string[]>(
    kv.get(KV_AD_CATEGORIES, categories()),
  )

  function toggleAds() {
    const next = !adsEnabled()
    setAdsEnabled(next)
    kv.set(KV_ADS_ENABLED, next)
    props.onChange?.({ adsEnabled: next, allowedCategories: allowedCategories() })
  }

  function toggleCategory(category: string) {
    const next = toggleArrayItem(allowedCategories(), category)
    setAllowedCategories(next)
    kv.set(KV_AD_CATEGORIES, next)
    props.onChange?.({ adsEnabled: adsEnabled(), allowedCategories: next })
  }

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
          <For each={categories()}>
            {(category) => {
              const active = () => allowedCategories().includes(category)
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? theme.backgroundPanel : undefined}
                  onMouseUp={() => toggleCategory(category)}
                >
                  <text fg={active() ? theme.success : theme.textMuted}>
                    {active() ? "✓" : "○"}
                  </text>
                  <text fg={active() ? theme.text : theme.textMuted}>
                    {category}
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
