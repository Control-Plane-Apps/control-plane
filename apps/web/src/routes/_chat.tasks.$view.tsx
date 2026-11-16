import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  TASK_VIEWS,
  TasksPage,
  type TasksSearch,
  type TasksView,
} from "../components/tasks/TasksPage";

const FILTERS = new Set(["week", "month", "year", "recurring", "completed"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const Route = createFileRoute("/_chat/tasks/$view")({
  validateSearch: (raw: Record<string, unknown>): TasksSearch => ({
    ...(typeof raw.project === "string" && raw.project.length > 0 ? { project: raw.project } : {}),
    ...(typeof raw.filter === "string" && FILTERS.has(raw.filter)
      ? { filter: raw.filter as TasksSearch["filter"] }
      : {}),
    ...(typeof raw.at === "string" && DATE.test(raw.at) ? { at: raw.at } : {}),
  }),
  beforeLoad: ({ params }) => {
    if (!TASK_VIEWS.includes(params.view as TasksView)) throw notFound();
  },
  component: TasksRouteView,
});

function TasksRouteView() {
  const { view } = Route.useParams();
  const search = Route.useSearch();
  return <TasksPage view={view as TasksView} search={search} />;
}
