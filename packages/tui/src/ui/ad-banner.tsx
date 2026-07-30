import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"
import { useToast } from "./toast"
import { useBindings } from "../keymap"
import { TextAttributes } from "@opentui/core"
import { SplitBorder } from "./border"
import open from "open"

export type AdPlacement = "thinking" | "toolgap"

export type AdData = {
  id: string
  headline: string
  body: string
  cta: string
  url: string
  category: string
}

export type AdBannerProps = {
  ad: AdData
  placement: AdPlacement
  visible: boolean
  durationMs?: number
  onDismiss?: (adId: string) => void
  onClick?: (adId: string) => void
  onCreditTimer?: (adId: string) => void
}

const DEFAULT_DURATIONS: Record<AdPlacement, number> = {
  thinking: 8_000,
  toolgap: 12_000,
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 1) + "…"
}

export function AdBanner(props: AdBannerProps) {
  const { theme } = useTheme()
  const clipboard = useClipboard()
  const toast = useToast()

  const [dismissed, setDismissed] = createSignal(false)

  const duration = () => props.durationMs ?? DEFAULT_DURATIONS[props.placement]

  // Auto-dismiss after configurable duration; fire credit timer at slot minimum dwell.
  createEffect(() => {
    if (!props.visible || dismissed()) return
    const creditHandle = setTimeout(() => {
      if (!dismissed()) props.onCreditTimer?.(props.ad.id)
    }, duration()).unref()
    const dismissHandle = setTimeout(() => {
      handleDismiss()
    }, duration() + 4000).unref()
    onCleanup(() => {
      clearTimeout(creditHandle)
      clearTimeout(dismissHandle)
    })
  })

  function handleDismiss() {
    setDismissed(true)
    props.onDismiss?.(props.ad.id)
  }

  function handleClick() {
    props.onClick?.(props.ad.id)
    open(props.ad.url).catch(() => {
      if (!clipboard.write) return
      clipboard
        .write(props.ad.url)
        .then(() => toast.show({ message: "Link copied to clipboard", variant: "info", duration: 2000 }))
        .catch(() => {})
    })
  }

  useBindings(() => ({
    bindings: [
      {
        key: "d",
        desc: "Dismiss ad",
        group: "Ad",
        cmd: () => {
          if (props.visible && !dismissed()) handleDismiss()
        },
      },
    ],
  }))

  return (
    <Show when={props.visible && !dismissed()}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.backgroundPanel}
        borderColor={theme.textMuted}
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
      >
        {/* Sponsored label */}
        <text fg={theme.textMuted}>
          sponsored
        </text>

        {/* Headline */}
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {" "}
          {props.ad.headline}
        </text>

        {/* Body — truncated to keep card compact */}
        <Show when={props.ad.body}>
          <text fg={theme.textMuted}>
            {" "}
            {truncateText(props.ad.body, 80)}
          </text>
        </Show>

        {/* CTA line */}
        <box flexDirection="row" gap={1}>
          <text
            fg={theme.primary}
            attributes={TextAttributes.BOLD}
            onMouseUp={handleClick}
          >
            {props.ad.cta}
          </text>
          <text fg={theme.textMuted}>
            {" "}
            [d] dismiss
          </text>
        </box>
      </box>
    </Show>
  )
}
