import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: { default: "Planbraid - One plan across every agent", template: "%s" },
    description: "Braid every coding agent's plans, progress, blockers, and completions into one trusted project record.",
    applicationName: "Planbraid",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/planbraid-favicon.png", type: "image/png", sizes: "512x512" },
        { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16 32x32 48x48 64x64" },
      ],
      shortcut: "/planbraid-favicon.png",
      apple: "/planbraid-favicon.png",
    },
    openGraph: { title: "Planbraid", description: "One trusted project plan across every coding agent", type: "website", url: origin },
    twitter: { card: "summary", title: "Planbraid", description: "One trusted project plan across every coding agent" },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
