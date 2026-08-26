import { redirect } from "next/navigation";

export default function DashboardSettingsRedirectPage() {
    redirect("/settings/billing");
}
