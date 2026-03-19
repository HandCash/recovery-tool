"use client"

import { useEffect, useState } from "react"
import { P2PKH } from "@bsv/sdk"
import { ArrowRight, InfoIcon, Loader2, Send } from "lucide-react"

import { formatBsv, formatTokenAmount } from "@/lib/handcash/format"
import type { RecoveryResult, SweepPlan, SweepProgress } from "@/lib/handcash/types"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface TransferPanelProps {
  result: RecoveryResult
  onEstimate: (destination: string) => Promise<SweepPlan>
  onTransfer: (destination: string) => Promise<void>
  isSending: boolean
  progress: SweepProgress | null
}

function describeProgress(progress: SweepProgress | null): string {
  switch (progress?.stage) {
    case "scripts":
      return progress.total
        ? `Signing items ${(progress.completed ?? 0).toLocaleString("en-US")} / ${progress.total.toLocaleString("en-US")}…`
        : "Signing…"
    case "broadcast":
      return "Broadcasting…"
    case "mnee":
      return "Sending MNEE…"
    default:
      return "Sending…"
  }
}

function isValidAddress(address: string): boolean {
  try {
    new P2PKH().lock(address)
    return true
  } catch {
    return false
  }
}

export function TransferPanel({
  result,
  onEstimate,
  onTransfer,
  isSending,
  progress,
}: TransferPanelProps) {
  const [destination, setDestination] = useState("")
  const [plan, setPlan] = useState<SweepPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const trimmed = destination.trim()
  const addressLooksValid = trimmed.length > 0 && isValidAddress(trimmed)

  // Re-price the sweep whenever the destination becomes valid, so the user sees
  // the exact amount and fee before committing to anything.
  useEffect(() => {
    if (!addressLooksValid) {
      setPlan(null)
      setPlanError(null)
      return
    }

    let cancelled = false
    setPlanError(null)

    onEstimate(trimmed)
      .then((next) => {
        if (!cancelled) setPlan(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setPlan(null)
        setPlanError(error instanceof Error ? error.message : "Could not price this transfer.")
      })

    return () => {
      cancelled = true
    }
  }, [trimmed, addressLooksValid, onEstimate])

  const nothingToSend = result.utxos.length === 0

  if (nothingToSend) {
    return (
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Nothing left to recover</CardTitle>
          <CardDescription>
            This wallet holds no unspent outputs on any HandCash derivation path.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            If you expected a balance here, check that both keys come from the
            same, most recent export of this wallet — keys from different exports
            or accounts combine into a valid but entirely different wallet.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Move everything out</CardTitle>
        <CardDescription>
          One transaction sends your BSV, items and tokens to the address below.
          MNEE, if any, follows in a second transaction through the MNEE
          cosigner.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Input
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value)
              setConfirming(false)
            }}
            placeholder="Destination BSV address"
            spellCheck={false}
            autoComplete="off"
            aria-label="Destination BSV address"
            aria-invalid={trimmed.length > 0 && !addressLooksValid}
            className={cn(
              "font-mono text-sm",
              trimmed.length > 0 &&
                !addressLooksValid &&
                "border-destructive focus-visible:ring-destructive"
            )}
          />
          {trimmed.length > 0 && !addressLooksValid && (
            <p className="px-1 text-xs text-destructive">
              That is not a valid Bitcoin SV address.
            </p>
          )}
          {planError && <p className="px-1 text-xs text-destructive">{planError}</p>}
        </div>

        {plan && (
          <dl className="space-y-1.5 rounded-lg border border-border/60 bg-secondary/30 p-3 text-sm">
            <Row label="BSV to send" value={`${formatBsv(plan.satoshisToSend)} BSV`} emphasis />
            {plan.itemCount > 0 && <Row label="Items" value={String(plan.itemCount)} />}
            {plan.tokenCount > 0 && <Row label="Tokens" value={String(plan.tokenCount)} />}
            <Row label="Inputs" value={String(plan.inputCount)} />
            <Row
              label="Network fee"
              value={`${plan.feeSatoshis.toLocaleString("en-US")} sats`}
            />
            {plan.mnee && !plan.mnee.problem && (
              <>
                <Row
                  label="MNEE to send"
                  value={`$${formatTokenAmount(plan.mnee.send, plan.mnee.decimals)}`}
                  emphasis
                />
                <Row
                  label="MNEE fee"
                  value={`$${formatTokenAmount(plan.mnee.fee, plan.mnee.decimals)}`}
                />
              </>
            )}
          </dl>
        )}

        {plan?.mnee?.problem && (
          <Alert>
            <InfoIcon className="h-4 w-4" aria-hidden />
            <AlertTitle className="text-sm">MNEE will stay behind</AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground">
              {plan.mnee.problem}
            </AlertDescription>
          </Alert>
        )}

        <Alert>
          <InfoIcon className="h-4 w-4" aria-hidden />
          <AlertTitle className="text-sm">This cannot be undone</AlertTitle>
          <AlertDescription className="text-xs text-muted-foreground">
            Check the address character by character. A transaction sent to the
            wrong address is unrecoverable.
          </AlertDescription>
        </Alert>

        {confirming ? (
          <div className="space-y-2">
            <p className="text-center text-xs text-muted-foreground">
              Send everything to{" "}
              <span className="break-all font-mono text-foreground">{trimmed}</span>?
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setConfirming(false)}
                disabled={isSending}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={() => void onTransfer(trimmed)}
                disabled={isSending}
              >
                {isSending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    {describeProgress(progress)}
                  </>
                ) : (
                  <>
                    Confirm
                    <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="lg"
            className="w-full"
            onClick={() => setConfirming(true)}
            disabled={!plan || isSending}
          >
            <Send className="mr-2 h-4 w-4" aria-hidden />
            Transfer everything
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-right tabular-nums",
          emphasis ? "font-semibold text-primary" : "text-sm"
        )}
      >
        {value}
      </dd>
    </div>
  )
}
