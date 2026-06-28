import { TextAttributes } from "@opentui/core"
import { onMount } from "solid-js"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { useWallet } from "../../context/wallet"
import { AdPreferences } from "../../ui/ad-preferences"
import { WithdrawPanel } from "../../ui/withdraw-panel"
import { useBindings } from "../../keymap"

export function DialogAds() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const wallet = useWallet()

  onMount(() => {
    dialog.setSize("large")
  })

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close ad preferences", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close ad preferences", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

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
          adsSeen: wallet.sessionAdsSeen,
          creditsEarned: wallet.sessionDelta,
          clickCount: wallet.sessionClicks,
        }}
        // Keep the wallet's reactive isEnabled in sync with the panel toggle.
        // AdPreferences persists to the same `codefree_ads_enabled` KV key.
        onChange={(prefs) => wallet.setEnabled(prefs.adsEnabled)}
      />
      <WithdrawPanel />
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>done</text>
        </box>
      </box>
    </box>
  )
}
