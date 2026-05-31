import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans, Playfair_Display } from "next/font/google";
import "./globals.css";
import { BRAND_TITLE } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { ClientProviders } from "@/providers/ClientProviders";

const playfairDisplayHeading = Playfair_Display({ subsets: ['latin'], variable: '--font-heading' });
const notoSans = Noto_Sans({ subsets: ['latin'], variable: '--font-sans' });
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export function generateMetadata(): Metadata {
  return {
    title: {
      default: BRAND_TITLE,
      template: `%s | ${BRAND_TITLE}`,
    },
    description: `${BRAND_TITLE} console for portfolio tracking and AI workflows.`,
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", notoSans.variable, playfairDisplayHeading.variable)}
    >
      <body className="min-h-full flex flex-col">
        {/* SessionProvider must wrap AuthProvider */}
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
