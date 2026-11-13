import { cn } from "~/lib/utils";

/** The Assistant's mark: a ring, drawn in the current text color. */
export function AssistantMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("shrink-0", className)}
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19zm0 5.5a4 4 0 1 1 0 8a4 4 0 1 1 0-8z"
      />
    </svg>
  );
}
