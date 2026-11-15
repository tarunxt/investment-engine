import { redirect } from "next/navigation";

import { URLs } from "@/lib/urls";

// Keep bookmarked URLs safe after retiring the console settings screen.
export default function GoogleSheetsLegacyPage() {
  redirect(URLs.routes.console.dashboard());
}
