import type { Metadata } from "next";
import "./globals.css";
import { BRAND_TITLE } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { ClientProviders } from "@/providers/ClientProviders";

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
      className={cn("h-full", "antialiased", "font-sans")}
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
