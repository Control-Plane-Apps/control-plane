/**
 * Sidebar nav. New Chat and Search sit as icons in the title bar, right of the
 * collapse toggle; the search field opens under them on demand.
 */
import { SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** "New Chat (⌘N)", or the bare label when the command has no shortcut. */
export function sidebarActionTooltip(label: string, shortcutLabel: string | null): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label;
}

/** The search field shows while opened from its icon, and always while it holds a query. */
export function isSidebarSearchFieldVisible(open: boolean, query: string): boolean {
  return open || query.length > 0;
}

/** New Chat and Search as icon buttons, for the title bar beside the collapse toggle. */
export function SidebarTitlebarActions({
  onNewChat,
  newChatDisabled = false,
  newChatTooltip,
  searchOpen,
  onToggleSearch,
  searchTooltip,
}: {
  onNewChat: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
  newChatDisabled?: boolean;
  newChatTooltip: string;
  searchOpen: boolean;
  onToggleSearch: () => void;
  searchTooltip: string;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <SidebarHeaderIconButton
        label="New Chat"
        tooltip={newChatTooltip}
        tooltipSide="bottom"
        disabled={newChatDisabled}
        onClick={() => onNewChat()}
        data-testid="sidebar-new-chat"
      >
        <SquarePenIcon aria-hidden className="size-4" />
      </SidebarHeaderIconButton>
      <SidebarHeaderIconButton
        label="Search"
        tooltip={searchTooltip}
        tooltipSide="bottom"
        aria-pressed={searchOpen}
        onClick={onToggleSearch}
        data-testid="sidebar-search"
      >
        <SearchIcon aria-hidden className="size-4" />
      </SidebarHeaderIconButton>
    </div>
  );
}

export interface SidebarThreadHeaderProps {
  /** Lands on the search field so a popup can anchor to its width. */
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** Leaving an empty field closes it. */
  onSearchBlur?: (event: ReactFocusEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
  onSearchBlur,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <div
          ref={searchFieldRef}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[length:1em] font-normal leading-tight text-sidebar-foreground hover:bg-sidebar-row-hover"
        >
          <SearchIcon className="size-3.5 shrink-0 text-[var(--sidebar-icon-color)]" />
          <Input
            ref={searchInputRef}
            nativeInput
            unstyled
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            onBlur={onSearchBlur}
            placeholder="Search"
            aria-label="Search threads"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-[length:1em] [&_[data-slot=input]]:font-normal [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-foreground"
          />
          {isSearching ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost"
              className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
              aria-label="Clear thread search"
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  tooltipSide = "top",
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  tooltipSide?: "top" | "bottom";
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn(
              "relative size-7 shrink-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              className,
            )}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side={tooltipSide}>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
