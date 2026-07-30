import { TextAttributes } from "@opentui/core"
import { createSignal, onMount } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { useWallet } from "../../context/wallet"
import { useSDK } from "../../context/sdk"
import { AdPreferences } from "../../ui/ad-preferences"
import { WithdrawPanel } from "../../ui/withdraw-panel"
import { useBindings } from "../../keymap"

type WalletSummary = {
  balance_credits: number
  lifetime_earned: number
  earned_today: number
  ads_today: number
  clicks_today: number
}

export function DialogAds() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const wallet = useWallet()
  const sdk = useSDK()
  const [summary, setSummary] = createSignal<WalletSummary | null>(null)

  onMount(() => {
    dialog.setSize("large")
    const directory = sdk.directory
    const suffix = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    void fetch(`${sdk.url}/codefree/wallet/summary${suffix}`)
      .then((response) => response.json())
      .then((body) => setSummary(body as WalletSummary))
      .catch(() => {})
  })

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close ad preferences", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close ad preferences", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  async function requestWithdraw(amountCredits: number) {
    const directory = sdk.directory
    const suffix = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const response = await fetch(`${sdk.url}/codefree/withdraw${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_credits: amountCredits }),
    })
    return (await response.json()) as { status: string; message?: string }
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Ad Preferences & Wallet
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <AdPreferences
        dailySummary={{
          adsSeen: summary()?.ads_today ?? wallet.sessionAdsSeen,
          creditsEarned: summary()?.earned_today ?? wallet.sessionDelta,
          clickCount: summary()?.clicks_today ?? wallet.sessionClicks,
        }}
        onChange={(prefs) => wallet.setEnabled(prefs.adsEnabled)}
      />
      <WithdrawPanel onRequestWithdraw={requestWithdraw} />
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>done</text>
        </box>
      </box>
    </box>
  )
}
