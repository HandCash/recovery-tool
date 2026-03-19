"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { LogOut } from "lucide-react"
import { toast } from "sonner"

import type {
  RecoveryResult,
  ScanProgress,
  SweepPlan,
  SweepProgress,
  SweepResult,
} from "@/lib/handcash/types"
import { HandCashWallet } from "@/lib/handcash/wallet"
import { Button } from "@/components/ui/button"
import { AssetsPanel } from "@/components/assets-panel"
import { RecoveryKeysForm } from "@/components/recovery-keys-form"
import { ScanningPanel } from "@/components/scanning-panel"
import { SuccessPanel } from "@/components/success-panel"
import { TransferPanel } from "@/components/transfer-panel"

type Step = "keys" | "scanning" | "assets" | "done"

export default function RecoveryPage() {
  /**
   * The wallet lives in a ref and nowhere else. It is never written to
   * localStorage, sessionStorage or a cookie, so closing the tab discards the
   * keys.
   */
  const walletRef = useRef<HandCashWallet | null>(null)

  const [step, setStep] = useState<Step>("keys")
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [result, setResult] = useState<RecoveryResult | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [sweepProgress, setSweepProgress] = useState<SweepProgress | null>(null)
  const [receipt, setReceipt] = useState<{ result: SweepResult; destination: string } | null>(null)

  // Each step replaces the whole view; without this the user lands mid-page.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [step])

  const runScan = useCallback(async (wallet: HandCashWallet) => {
    setStep("scanning")
    setProgress(null)

    try {
      const scanned = await wallet.scan(setProgress)
      setResult(scanned)
      setStep("assets")

      if (scanned.utxos.length === 0) {
        toast.info("Nothing found", {
          description: "This wallet holds no unspent outputs.",
        })
      }
    } catch (error) {
      console.error(error)
      setStep(result ? "assets" : "keys")
      toast.error("Scan failed", {
        description:
          error instanceof Error
            ? error.message
            : "A block explorer did not respond. Please try again.",
      })
    }
  }, [result])

  const handleRecover = useCallback(
    async ([first, second]: [string, string]) => {
      try {
        walletRef.current = HandCashWallet.fromExtendedKeys(first, second)
      } catch (error) {
        toast.error("Invalid private keys", {
          description: error instanceof Error ? error.message : undefined,
        })
        return
      }
      await runScan(walletRef.current)
    },
    [runScan]
  )

  const handleEstimate = useCallback(
    async (destination: string): Promise<SweepPlan> => {
      const wallet = walletRef.current
      if (!wallet || !result) throw new Error("Nothing has been scanned yet.")
      return wallet.plan(destination, result.utxos)
    },
    [result]
  )

  const handleTransfer = useCallback(
    async (destination: string) => {
      const wallet = walletRef.current
      if (!wallet || !result) return

      setIsSending(true)
      setSweepProgress(null)
      try {
        const sweep = await wallet.sweep(destination, result.utxos, setSweepProgress)
        setReceipt({ result: sweep, destination })
        setStep("done")
      } catch (error) {
        console.error(error)
        toast.error("Transfer failed", {
          description:
            error instanceof Error ? error.message : "The transaction was not broadcast.",
        })
      } finally {
        setIsSending(false)
        setSweepProgress(null)
      }
    },
    [result]
  )

  const reset = useCallback(() => {
    walletRef.current = null
    setResult(null)
    setProgress(null)
    setReceipt(null)
    setStep("keys")
  }, [])

  return (
    <div className="container py-10 sm:py-14">
      {step === "keys" && (
        <RecoveryKeysForm onRecover={handleRecover} isBusy={false} />
      )}

      {step === "scanning" && <ScanningPanel progress={progress} />}

      {step === "assets" && result && (
        <div className="mx-auto w-full max-w-xl space-y-4">
          <div className="space-y-1 text-center">
            <h1 className="font-display text-3xl font-bold tracking-tight">
              Your recovered assets
            </h1>
            <p className="text-xs text-muted-foreground">
              Found across {result.addressesScanned.toLocaleString("en-US")} addresses
            </p>
          </div>

          <AssetsPanel
            result={result}
            isScanning={false}
            onRescan={() => {
              if (walletRef.current) void runScan(walletRef.current)
            }}
          />

          <TransferPanel
            result={result}
            onEstimate={handleEstimate}
            onTransfer={handleTransfer}
            isSending={isSending}
            progress={sweepProgress}
          />

          <Button
            variant="ghost"
            className="w-full text-xs text-muted-foreground"
            onClick={reset}
          >
            <LogOut className="mr-2 h-3.5 w-3.5" aria-hidden />
            Forget this wallet
          </Button>
        </div>
      )}

      {step === "done" && receipt && (
        <SuccessPanel
          result={receipt.result}
          destination={receipt.destination}
          onStartOver={reset}
        />
      )}
    </div>
  )
}
