import type { Metadata, Viewport } from "next";
import { Press_Start_2P, VT323 } from "next/font/google";
import "./globals.css";

// Retro font pairing for the whole app:
// - Press Start 2P: headings, labels, scores (blocky 8-bit display type)
// - VT323: body / dense text (readable monospace with a retro-terminal feel)
const pressStart2P = Press_Start_2P({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-press-start",
  display: "swap",
});

const vt323 = VT323({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-vt323",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TD's Only League",
  description: "8-manager private fantasy football league. TDs only.",
  manifest: "/manifest.json",
  // iOS only offers Web Push to a site launched from the home screen, so the
  // install path is a feature, not a nicety: appleWebApp gives the launcher
  // the right name and a status bar that matches the field-dark header.
  appleWebApp: {
    capable: true,
    title: "TD's Only",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#07301d",
  // The scoreboard is dense on a phone; let people pinch it if they want.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${pressStart2P.variable} ${vt323.variable}`}>
      <body>{children}</body>
    </html>
  );
}
