import { notFound } from "next/navigation";
import { ScreenerLibrary } from "@/components/screeners/ScreenerLibrary";

export default async function Page({ params, searchParams }: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ strategy?: string }>;
}) {
  const [{ path = [] }, { strategy = "og" }] = await Promise.all([params, searchParams]);
  if (strategy !== "og" && strategy !== "bfs") notFound();
  if (path.length > 1 || (path[0] && !/^(create|swing|bottom|custom-[a-f0-9]{32})$/.test(path[0]))) notFound();
  return <ScreenerLibrary screen={path[0] ?? "explore"} strategy={strategy}/>;
}
