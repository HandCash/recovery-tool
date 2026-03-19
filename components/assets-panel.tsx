"use client"

import { useMemo } from "react"
import { AlertTriangle, Coins, ImageIcon, RefreshCw, Wallet } from "lucide-react"

import { formatBsv, formatSatoshis, formatTokenAmount, truncateMiddle } from "@/lib/handcash/format"
import { contentUrl } from "@/lib/handcash/oneSat"
import type { RecoveryResult } from "@/lib/handcash/types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** Rendering thousands of item tiles at once stalls the page; the rest are summarised. */
const ITEMS_SHOWN = 60

interface AssetsPanelProps {
  result: RecoveryResult
  onRescan: () => void
  isScanning: boolean
}

export function AssetsPanel({ result, onRescan, isScanning }: AssetsPanelProps) {
  const byRoot = useMemo(() => {
    const counts = new Map<string, number>()
    for (const utxo of result.utxos) {
      counts.set(utxo.derivationRoot, (counts.get(utxo.derivationRoot) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [result.utxos])

  return (
    <div className="space-y-4">
      {!result.complete && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle className="text-sm">This scan may be incomplete</AlertTitle>
          <AlertDescription className="text-xs">
            A block explorer, the MNEE service or the items indexer did not
            respond during the scan. Some assets could be missing, and parts of
            the scan may have stopped early. Scan again before transferring.
          </AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden border-primary/20">
        <div className="bg-gradient-to-b from-primary/10 to-transparent">
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Wallet className="h-4 w-4" aria-hidden />
              Recoverable balance
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRescan}
              disabled={isScanning}
              aria-label="Scan again"
            >
              <RefreshCw
                className={`h-4 w-4 ${isScanning ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
          </CardHeader>

          <CardContent className="space-y-4 pb-6">
            <div>
              <p className="font-display text-4xl font-bold tabular-nums tracking-tight">
                {formatBsv(result.satoshis)}
                <span className="ml-2 text-lg font-semibold text-muted-foreground">BSV</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatSatoshis(result.satoshis)} satoshis across{" "}
                {result.utxos.filter((u) => u.kind === "bsv").length} output
                {result.utxos.filter((u) => u.kind === "bsv").length === 1 ? "" : "s"}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {byRoot.map(([root, count]) => (
                <span
                  key={root}
                  className="rounded-full border border-border/70 bg-secondary/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                >
                  {root} · {count}
                </span>
              ))}
              {byRoot.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No unspent outputs on any derivation path.
                </span>
              )}
            </div>
          </CardContent>
        </div>
      </Card>

      {result.tokens.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Coins className="h-4 w-4 text-primary" aria-hidden />
              Tokens
              <span className="text-sm font-normal text-muted-foreground">
                ({result.tokens.length})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {result.tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{token.symbol}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {token.cosigned
                      ? "Moved separately, through the MNEE cosigner"
                      : truncateMiddle(token.id, 10, 8)}
                  </p>
                </div>
                <p className="shrink-0 pl-3 text-sm font-semibold tabular-nums">
                  {formatTokenAmount(token.amount, token.decimals)}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {result.items.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="h-4 w-4 text-primary" aria-hidden />
              Items
              <span className="text-sm font-normal text-muted-foreground">
                ({result.items.length})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {result.items.slice(0, ITEMS_SHOWN).map((item) => {
                const origin = item.item?.origin
                const isImage = item.item?.contentType?.startsWith("image/")
                return (
                  <li
                    key={`${item.txid}_${item.vout}`}
                    className="overflow-hidden rounded-lg border border-border/60 bg-secondary/30"
                  >
                    <div className="flex aspect-square items-center justify-center bg-background/40">
                      {origin && isImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={contentUrl(origin)}
                          alt={item.item?.name ?? "Item"}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <ImageIcon
                          className="h-6 w-6 text-muted-foreground/40"
                          aria-hidden
                        />
                      )}
                    </div>
                    <p className="truncate px-2 py-1.5 text-[11px] text-muted-foreground">
                      {item.item?.name ?? truncateMiddle(item.txid, 6, 4)}
                    </p>
                  </li>
                )
              })}
            </ul>
            {result.items.length > ITEMS_SHOWN && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                and {(result.items.length - ITEMS_SHOWN).toLocaleString("en-US")} more
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
