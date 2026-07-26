import type { Metadata } from "next";
import "./globals.css";
import { BRAND_TITLE } from "@/lib/brand";
import { cn } from "@/lib/utils";

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
      suppressHydrationWarning
      className={cn("h-full", "antialiased", "font-sans")}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var theme=window.localStorage.getItem("investment-engine:theme-preference")||window.localStorage.getItem("investor:theme-preference")||"light";var isDark=theme==="dark"||(theme==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",isDark);document.documentElement.style.colorScheme=isDark?"dark":"light";}catch(e){}})();`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
