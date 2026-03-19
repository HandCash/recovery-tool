"use client"

import { useState } from "react"
import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react"

import { HandCashWallet } from "@/lib/handcash/wallet"
import { extractExtendedKeys, parseExtendedPrivateKey } from "@/lib/handcash/keyring"
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
import { Textarea } from "@/components/ui/textarea"

type KeyPair = [string, string]

const FIELD_LABELS = ["First key", "Second key"] as const

interface RecoveryKeysFormProps {
  onRecover: (keys: KeyPair) => void
  isBusy: boolean
}

export function RecoveryKeysForm({ onRecover, isBusy }: RecoveryKeysFormProps) {
  const [keys, setKeys] = useState<KeyPair>(["", ""])
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setKey = (index: number, value: string) => {
    setKeys((current) => {
      const next: KeyPair = [...current]
      next[index] = value
      return next
    })
    setError(null)
  }

  // An export copied as one block carries both keys; split it across the fields
  // instead of leaving the user to separate them by hand.
  const handlePaste = (index: number, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const found = extractExtendedKeys(event.clipboardData.getData("text"))
    if (found.length < 2) return
    event.preventDefault()
    setKeys([found[0], found[1]])
    setError(null)
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()

    const trimmed: KeyPair = [keys[0].trim(), keys[1].trim()]
    const problem = HandCashWallet.describeProblem(...trimmed)
    if (problem) {
      setError(problem)
      return
    }

    setError(null)
    onRecover(trimmed)
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <div className="space-y-2 text-center">
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Recover your HandCash wallet
        </h1>
        <p className="text-balance text-sm text-muted-foreground">
          Enter the two private keys exported from the HandCash app. This tool
          will find every asset your wallet holds and let you move it to an
          address you control.
        </p>
      </div>

      <Card>
        <CardHeader className="space-y-1.5">
          <CardTitle className="flex items-center justify-between gap-2 text-lg">
            <span className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden />
              Private keys
            </span>
            <button
              type="button"
              onClick={() => setRevealed((value) => !value)}
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={revealed ? "Hide keys" : "Show keys"}
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
            </button>
          </CardTitle>
          <CardDescription>
            Both start with <span className="font-mono">xprv</span>. They can go
            in either order.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {FIELD_LABELS.map((label, index) => {
              const value = keys[index]
              const isValid = parseExtendedPrivateKey(value) !== null
              const id = `recovery-key-${index}`

              return (
                <div key={label} className="space-y-1.5">
                  <div className="flex items-center justify-between px-1 text-xs">
                    <label htmlFor={id} className="font-medium">
                      {label}
                    </label>
                    {isValid && (
                      <span className="flex items-center gap-1 text-primary">
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                        Valid key
                      </span>
                    )}
                  </div>
                  <Textarea
                    id={id}
                    value={value}
                    onChange={(event) => setKey(index, event.target.value)}
                    onPaste={(event) => handlePaste(index, event)}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    data-1p-ignore
                    data-lpignore="true"
                    aria-invalid={error !== null}
                    placeholder="xprv9s21ZrQH143K…"
                    className={cn(
                      "min-h-0 resize-none break-all font-mono text-sm leading-relaxed",
                      !revealed && value.length > 0 && "[-webkit-text-security:disc]",
                      error && "border-destructive focus-visible:ring-destructive"
                    )}
                  />
                </div>
              )
            })}

            {error && (
              <p role="alert" className="px-1 text-xs text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" className="w-full" disabled={isBusy}>
              {isBusy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Recovering…
                </>
              ) : (
                "Recover"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Alert className="border-primary/20 bg-primary/5">
        <AlertTriangle className="h-4 w-4 text-primary" aria-hidden />
        <AlertTitle className="text-sm">Only use keys you own</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          Anyone who has these two keys can spend your funds. Never enter them
          on a site you did not open yourself, and close this tab when you are
          finished.
        </AlertDescription>
      </Alert>
    </div>
  )
}
