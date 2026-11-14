import { listScheduleProjects } from "@t3tools/client-runtime/state/schedules";
import { useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useProjects, useServerConfigs } from "../../state/entities";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SchedulesPanelContent } from "./SchedulesPanel";

// Fork-owned. Every schedule across Projects, the Assistant's first: one
// section per Project with its rows, switches and editor.

export function SchedulesPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const entries = listScheduleProjects(projects).flatMap((entry) => {
    const capability = serverConfigs.get(entry.project.environmentId)?.environment.capabilities
      .projectSchedules;
    return capability === undefined ? [] : [{ ...entry, capability }];
  });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto border-b border-border">
          <div className="flex w-full items-center py-2">
            <WorkspaceBreadcrumb ariaLabel="Schedules breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Schedules</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-4">
            {entries.length === 0 ? (
              <div className="flex flex-col items-start gap-2 text-muted-foreground text-sm">
                <p>No schedules yet. Ask a Project coordinator or the Assistant to set one up.</p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/assistant" })}
                >
                  Assistant settings
                </Button>
              </div>
            ) : (
              entries.map((entry) => (
                <SchedulesPanelContent
                  key={`${entry.project.environmentId}:${entry.project.id}`}
                  project={entry.project}
                  scheduler={entry.capability.scheduler}
                  capabilityZone={entry.capability.timeZone}
                  variant="section"
                  heading={entry.label}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
