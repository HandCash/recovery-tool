import "@/styles/globals.css"

import type { Metadata, Viewport } from "next"
import { Archivo } from "next/font/google"

import { cn } from "@/lib/utils"
import { Toaster } from "@/components/ui/sonner"
import { SiteFooter } from "@/components/site-footer"
import { SiteHeader } from "@/components/site-header"

// Archivo is HandCash's product typeface.
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
})

export const metadata: Metadata = {
  title: "HandCash Recovery",
  description:
    "Recover the BSV, items and tokens held by a HandCash wallet using the two private keys exported from the HandCash app, and move everything to an address you control.",
  icons: { icon: "/favicon.png" },
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: "#12151a",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={cn("min-h-screen font-sans", archivo.variable)}>
        <div className="relative flex min-h-screen flex-col">
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </div>
        <Toaster position="top-center" richColors />
      </body>
    </html>
  )
}
