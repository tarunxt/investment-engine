import { redirect } from "next/navigation";
import { URLs } from "@/lib/urls";

export default function AdminCostDriversRedirectPage() {
  redirect(URLs.routes.profile.costDrivers());
}
