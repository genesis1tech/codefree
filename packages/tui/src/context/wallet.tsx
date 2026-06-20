import { createStore, produce } from "solid-js/store"
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useEvent } from "./event"

// Shared with the AdPreferences panel so the enable toggle and the wallet
// agree on the persisted on/off state.
const KV_ADS_ENABLED = "codefree_ads_enabled"

// Phase 0 MVP credit economics. Real per-impression / per-click values will
// come from the ad server once the wallet HTTP endpoint ships.
const IMPRESSION_CREDIT = 1
const CLICK_CREDIT = 5

// Wallet field names mirror the server wallet table columns (snake_case) so
// they can be reconciled 1:1 with the API response without renaming.
type WalletStore = {
  balance_credits: number
  lifetime_earned: number
  lifetime_spent: number
  // Credits earned in this TUI session only — resets on restart.
  session_delta: number
  session_ads_seen: number
  session_clicks: number
  is_enabled: boolean
}

export const { use: useWallet, provider: WalletProvider } = createSimpleContext({
  name: "Wallet",
  init: () => {
    const kv = useKV()
    const event = useEvent()

    const [store, setStore] = createStore<WalletStore>({
      balance_credits: 0,
      lifetime_earned: 0,
      lifetime_spent: 0,
      session_delta: 0,
      session_ads_seen: 0,
      session_clicks: 0,
      // Phase 0 default: ads disabled. NOTE: the shipped AdPreferences panel
      // defaults this same KV key to `true`, so on a fresh install (key unset)
      // the two views disagree until the user toggles once. They stay in sync
      // afterwards because both read/write `codefree_ads_enabled`.
      is_enabled: kv.get(KV_ADS_ENABLED, false),
    })

    // ---- Phase 0: local-only state, no server roundtrip. ----
    // When the wallet endpoint lands, refresh() should fetch authoritative
    // balances and reconcile the store, mirroring how sync.tsx bootstraps
    // server data (sdk.client.experimental.wallet.get + reconcile).
    async function refresh() {
      // TODO(server): const result = await sdk.client.experimental.wallet.get(...)
      // setStore(reconcile(result.data)). Left local-only for Phase 0.
      return
    }

    function recordAdView(amount = IMPRESSION_CREDIT) {
      setStore(
        produce((draft) => {
          draft.balance_credits += amount
          draft.lifetime_earned += amount
          draft.session_delta += amount
          draft.session_ads_seen += 1
        }),
      )
    }

    function recordClick(amount = CLICK_CREDIT) {
      setStore(
        produce((draft) => {
          draft.balance_credits += amount
          draft.lifetime_earned += amount
          draft.session_delta += amount
          draft.session_clicks += 1
        }),
      )
    }

    function setEnabled(next: boolean) {
      setStore("is_enabled", next)
      kv.set(KV_ADS_ENABLED, next)
    }

    // ---- Server-sent event hooks. ----
    // The processor emits ad impression / credit events when ads are served.
    // Those event types are not in the SDK Event union yet, so we match on the
    // raw type string. Once first-class ad events exist, switch to
    // event.on("codefree.ad.impression", ...) / event.on("codefree.credit.updated", ...).
    const unsubscribe = event.subscribe((evt) => {
      const type = evt.type as string
      if (type === "codefree.ad.impression") {
        const amount = (evt.properties as { amount?: number }).amount ?? IMPRESSION_CREDIT
        recordAdView(amount)
        return
      }
      if (type === "codefree.credit.updated") {
        const properties = evt.properties as {
          balance_credits?: number
          lifetime_earned?: number
          lifetime_spent?: number
        }
        if (properties.balance_credits !== undefined) setStore("balance_credits", properties.balance_credits)
        if (properties.lifetime_earned !== undefined) setStore("lifetime_earned", properties.lifetime_earned)
        if (properties.lifetime_spent !== undefined) setStore("lifetime_spent", properties.lifetime_spent)
      }
    })
    onCleanup(unsubscribe)

    return {
      get balance() {
        return store.balance_credits
      },
      get lifetimeEarned() {
        return store.lifetime_earned
      },
      get lifetimeSpent() {
        return store.lifetime_spent
      },
      get sessionDelta() {
        return store.session_delta
      },
      get sessionAdsSeen() {
        return store.session_ads_seen
      },
      get sessionClicks() {
        return store.session_clicks
      },
      get isEnabled() {
        return store.is_enabled
      },
      refresh,
      recordAdView,
      recordClick,
      setEnabled,
    }
  },
})
