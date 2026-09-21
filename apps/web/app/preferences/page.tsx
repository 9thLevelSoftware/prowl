import { getPreferences } from "@prowl/db";
import { PageHeader } from "@/components/ui";
import { db, USER } from "@/lib/server";
import { PreferencesForm } from "./form";

export default function PreferencesPage() {
  return (
    <>
      <PageHeader title="Preferences" description="Changing these re-scores every job you've already found." />
      <PreferencesForm initial={getPreferences(db(), USER)} />
    </>
  );
}
