import { createMemo, Show } from "solid-js"
import { useTheme } from "../context/theme"

export type WalletState = {
  credits: number
  sessionDelta: number
}

export type WalletIndicatorProps = {
  wallet?: WalletState
}

function formatCredits(value: number): string {
  return value.toLocaleString("en-US")
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function WalletIndicator(props: WalletIndicatorProps) {
  const { theme } = useTheme()

  const formatted = createMemo(() => {
    const wallet = props.wallet
    if (!wallet) return null
    return {
      credits: formatCredits(wallet.credits),
      usd: formatUsd(wallet.credits / 100),
      delta: wallet.sessionDelta > 0 ? `+${formatCredits(wallet.sessionDelta)}` : undefined,
    }
  })

  return (
    <Show when={formatted()}>
      {(info) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.success}>
            💰
          </text>
          <text fg={theme.text}>
            {info().credits} credits ({info().usd})
          </text>
          <Show when={info().delta}>
            {(delta) => (
              <text fg={theme.success}>
                {delta()} today
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}
