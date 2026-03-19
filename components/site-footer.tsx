export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 py-6">
      <div className="container flex flex-col items-center gap-2 text-center">
        <p className="text-xs text-muted-foreground">
          Your private keys are never sent anywhere. Keys are derived, and
          transactions signed, entirely on this device.
        </p>
        <p className="text-xs text-muted-foreground/70">
          Balances are read from public block explorers, which see only your
          addresses.
        </p>
      </div>
    </footer>
  )
}
