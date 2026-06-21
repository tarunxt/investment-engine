import { redirect } from "next/navigation";

import { URLs } from "@/lib/urls";

export default function BullpenAiAutoLiveLegacyPage() {
  redirect(URLs.routes.console.bullpenAiAutoLive());
}
