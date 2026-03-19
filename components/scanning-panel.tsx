"use client"

import { Loader2, Radar } from "lucide-react"

import { DERIVATION_ROOTS } from "@/lib/handcash/derivation"
import type { ScanProgress } from "@/lib/handcash/types"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function ScanningPanel({ progress }: { progress: ScanProgress | null }) {
  const completed = progress ? progress.rootNumber - 1 : 0
  const percent = progress
    ? Math.min(100, Math.round((progress.rootNumber / progress.rootCount) * 100))
    : 0

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <div className="space-y-2 text-center">
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Scanning the blockchain
        </h1>
        <p className="text-balance text-sm text-muted-foreground">
          Walking every HandCash derivation path and checking each address for
          unspent outputs. This can take a few minutes.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Radar className="h-4 w-4 animate-pulse text-primary" aria-hidden />
            {progress?.rootLabel ?? "Starting"}
          </CardTitle>
          <span className="text-sm font-medium tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </CardHeader>

        <CardContent className="space-y-5">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Scan progress"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <Stat label="Addresses checked" value={progress?.addressesScanned ?? 0} />
            <Stat label="Outputs found" value={progress?.utxosFound ?? 0} highlight />
          </dl>

          <ul className="space-y-1">
            {DERIVATION_ROOTS.map((root, index) => {
              const state =
                index < completed ? "done" : index === completed ? "active" : "pending"
              return (
                <li
                  key={root.path}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs transition-colors",
                    state === "active" && "bg-primary/10 text-foreground",
                    state === "done" && "text-muted-foreground",
                    state === "pending" && "text-muted-foreground/50"
                  )}
                >
                  <span className="flex items-center gap-2">
                    {state === "active" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden />
                    ) : (
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          state === "done" ? "bg-primary/60" : "bg-muted-foreground/30"
                        )}
                      />
                    )}
                    {root.label}
                  </span>
                  <code className="font-mono text-[11px] opacity-60">{root.path}</code>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/40 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          highlight && value > 0 && "text-primary"
        )}
      >
        {value.toLocaleString("en-US")}
      </dd>
    </div>
  )
}
