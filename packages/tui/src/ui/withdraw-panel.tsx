import { Show, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useWallet } from "../context/wallet"

// Mirrors MIN_WITHDRAWAL_CREDITS from @opencode-ai/core/wallet/payout (1000 credits = $10).
export const MIN_WITHDRAWAL_CREDITS = 1000
export const CREDIT_USD_VALUE = 0.01

export type WithdrawPanelProps = {
  /** Called when the user triggers a withdrawal. The TUI layer wires this to the server route. */
  onRequestWithdraw?: (amountCredits: number) => void
}

export function WithdrawPanel(props: WithdrawPanelProps) {
  const { theme } = useTheme()
  const wallet = useWallet()

  const balance = () => wallet.balance
  const withdrawable = () => Math.max(0, balance() - 0)
  const canWithdraw = () => balance() >= MIN_WITHDRAWAL_CREDITS
  const [status, setStatus] = createSignal<string | null>(null)

  function formatUsd(credits: number) {
    return `$${(credits * CREDIT_USD_VALUE).toFixed(2)}`
  }

  function handleWithdraw() {
    if (!canWithdraw()) return
    setStatus(`Withdrawing ${withdrawable()} credits (${formatUsd(withdrawable())})...`)
    props.onRequestWithdraw?.(withdrawable())
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Cash Out
      </text>

      {/* Balance summary */}
      <box gap={1} paddingTop={1}>
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted}>Balance:</text>
          <text fg={theme.text}>
            {balance().toLocaleString()} credits ({formatUsd(balance())})
          </text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted}>Lifetime earned:</text>
          <text fg={theme.success}>
            {wallet.lifetimeEarned.toLocaleString()} credits
          </text>
        </box>
      </box>

      {/* Withdrawal threshold */}
      <box flexDirection="row" gap={1} paddingTop={1}>
        <text fg={theme.textMuted}>
          Minimum withdrawal: {MIN_WITHDRAWAL_CREDITS.toLocaleString()} credits ({formatUsd(MIN_WITHDRAWAL_CREDITS)})
        </text>
      </box>

      {/* Eligibility status */}
      <Show
        when={canWithdraw()}
        fallback={
          <text fg={theme.warning}>
            Need {MIN_WITHDRAWAL_CREDITS - balance()} more credits to withdraw
          </text>
        }
      >
        <text fg={theme.success}>
          Eligible to withdraw {withdrawable().toLocaleString()} credits ({formatUsd(withdrawable())})
        </text>
      </Show>

      {/* Withdraw button */}
      <Show when={canWithdraw()}>
        <box paddingTop={1}>
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.primary}
            onMouseUp={handleWithdraw}
          >
            <text fg={theme.selectedListItemText} attributes={TextAttributes.BOLD}>
              Withdraw all ({withdrawable().toLocaleString()} credits)
            </text>
          </box>
        </box>
      </Show>

      {/* Status message */}
      <Show when={status()}>
        <text fg={theme.textMuted}>{status()}</text>
      </Show>
    </box>
  )
}
