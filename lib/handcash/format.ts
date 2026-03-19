const SATOSHIS_PER_BSV = 100_000_000

export function formatBsv(satoshis: number): string {
  return (satoshis / SATOSHIS_PER_BSV).toLocaleString("en-US", {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  })
}

export function formatSatoshis(satoshis: number): string {
  return satoshis.toLocaleString("en-US")
}

/** Renders a token amount held in base units at `decimals` precision. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toLocaleString("en-US")

  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const fraction = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "")

  return fraction.length > 0
    ? `${whole.toLocaleString("en-US")}.${fraction}`
    : whole.toLocaleString("en-US")
}

export function truncateMiddle(value: string, lead = 8, tail = 6): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}
