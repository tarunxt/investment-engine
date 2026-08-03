import { redirect } from "next/navigation";

/**
 * Preserve the legacy database bookmark without exposing PostgreSQL or its
 * credentials through a public database-administration UI.
 *
 * Historical stock recommendations are available through the authenticated
 * Automated Rebalance console, including the GAIL history in its stock-detail
 * dialog.
 */
export default function LegacyDatabasePage() {
  redirect("/console/automated-rebalance");
}
