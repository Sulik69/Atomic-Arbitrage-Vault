import type { Metadata } from "next";
import "./globals.css";
import { AppProviders } from "@/components/solarb/app-providers";

export const metadata: Metadata = {
  title: "SolArb — Zero-Loss Flash Vault",
  description: "Devnet-first control surface for the SolArb atomic arbitrage vault.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppProviders>{children}</AppProviders></body></html>;
}
