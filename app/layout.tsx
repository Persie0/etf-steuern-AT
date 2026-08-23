import type { Metadata } from "next";
import "./globals.css";
import "./broker-events.css";

export const metadata: Metadata = {
  title: "ETF-Steuerassistent Österreich",
  description: "ETF-Steuern für österreichische Privatanleger mit Auslandsbroker berechnen und den richtigen E1kv-Kennzahlen zuordnen.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
