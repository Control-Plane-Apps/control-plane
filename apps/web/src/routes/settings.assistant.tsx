import { createFileRoute } from "@tanstack/react-router";

import { AssistantSettingsPage } from "../components/assistant/AssistantSettingsPage";

function SettingsAssistantRoute() {
  return <AssistantSettingsPage />;
}

export const Route = createFileRoute("/settings/assistant")({
  component: SettingsAssistantRoute,
});
