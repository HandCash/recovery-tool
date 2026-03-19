"use client"

import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react"

import { truncateMiddle } from "@/lib/handcash/format"
import type { SweepResult } from "@/lib/handcash/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface SuccessPanelProps {
  result: SweepResult
  destination: string
  onStartOver: () => void
}

export function SuccessPanel({ result, destination, onStartOver }: SuccessPanelProps) {
  const transactions = [
    { label: "Transaction", txid: result.txid },
    { label: "MNEE transaction", txid: result.mneeTxid },
  ].filter((entry): entry is { label: string; txid: string } => Boolean(entry.txid))

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <Card className="border-primary/30">
        <CardHeader className="items-center space-y-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15">
            <CheckCircle2 className="h-6 w-6 text-primary" aria-hidden />
          </div>
          <div className="space-y-1">
            <CardTitle className="font-display text-2xl">Transfer broadcast</CardTitle>
            <CardDescription>
              Everything recoverable has been sent to{" "}
              <span className="break-all font-mono text-foreground">{destination}</span>
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {result.mneeError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" aria-hidden />
              <AlertTitle className="text-sm">MNEE was not moved</AlertTitle>
              <AlertDescription className="text-xs">
                Everything else was sent, but the MNEE transfer failed:{" "}
                {result.mneeError} Scan again and transfer to retry it.
              </AlertDescription>
            </Alert>
          )}

          {transactions.map(({ label, txid }) => (
            <div key={txid} className="space-y-2">
              <div className="rounded-lg border border-border/60 bg-secondary/30 p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {label}
                </p>
                <p className="mt-0.5 break-all font-mono text-xs">{txid}</p>
              </div>

              <Button asChild variant="outline" className="w-full">
                <a
                  href={`https://whatsonchain.com/tx/${txid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View {truncateMiddle(txid, 6, 4)} on WhatsOnChain
                  <ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden />
                </a>
              </Button>
            </div>
          ))}

          <Button variant="ghost" className="w-full text-muted-foreground" onClick={onStartOver}>
            Recover another wallet
          </Button>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Confirmation can take a few minutes. Scan again afterwards to check that
        nothing was left behind.
      </p>
    </div>
  )
}
