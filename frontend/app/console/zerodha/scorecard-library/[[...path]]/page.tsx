import { redirect } from "next/navigation";
import { libraryPath } from "@/lib/scorecardBoard";
import { screenerPath } from "@/lib/screenerLibrary";

export default async function LegacyLibrary({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  redirect(path?.length ? libraryPath + "/" + path.map(encodeURIComponent).join("/") : screenerPath);
}
