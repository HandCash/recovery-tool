import Image from "next/image"
import { ShieldCheck } from "lucide-react"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="container flex h-16 items-center justify-between">
        <div className="flex items-center gap-3">
          <Image
            src="/handcash-icon.png"
            alt=""
            width={32}
            height={32}
            className="rounded-lg"
            priority
          />
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">HandCash</p>
            <p className="text-xs text-muted-foreground">Recovery</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span className="text-xs font-medium text-primary">Runs in your browser</span>
        </div>
      </div>
    </header>
  )
}
