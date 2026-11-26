import {
  AgentIntegration,
  LOCAL_AGENT_MACHINE,
  type AgentMachinePreference,
  type AgentMachineStatus,
  type AgentMachinesResult,
  type WaitingAgent,
  type AgentPlacementSettings,
  type AgentPlacementSettingsPatch,
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { MoreVertical, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  agentMachineEntryPatch,
  agentMachineLinkInput,
  agentMachineStatusDotClassName,
  agentMachineStatusPresentation,
  agentMachinesErrorMessage,
  agentMachineStatusesById,
  agentPlacementModeOptions,
  isAgentPlacementMode,
  linkedAgentMachines,
  projectMatchText,
  tokenRenewalText,
  agentMachineNeedsRelink,
  type LinkedAgentMachine,
  singleAgentMachineOptions,
  singleAgentMachineValue,
  summarizeAgentPlacement,
} from "./AgentMachinesSettings.logic";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { loadPreferences } from "./LoadBalancingSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { WaitingAgentsSettings } from "./WaitingAgentsSettings";

/**
 * Folded section under Load balancing: where coordinators on the environment
 * being viewed start new agents, and the machines linked to it. Unlike Load
 * balancing this is a server setting, so it edits that environment only and
 * is hidden until the environment is connected.
 */
export function AgentMachinesSettings() {
  const scope = useOptionalSettingsScope();
  const primaryEnvironment = usePrimaryEnvironment();
  const environment = scope ? scope.environment : primaryEnvironment;
  if (
    environment === null ||
    environment.connection.phase !== "connected" ||
    environment.serverConfig === null
  ) {
    return null;
  }
  return (
    <AgentMachinesSection
      key={environment.environmentId}
      environment={environment}
      placement={environment.serverConfig.settings.agentPlacement}
    />
  );
}

function MachinePrioritySettings({
  placement,
  projects,
  update,
}: {
  readonly placement: AgentPlacementSettings;
  readonly projects: ReadonlyArray<{ id: string; title: string }>;
  readonly update: (patch: AgentPlacementSettingsPatch) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const required = placement.projectRequirements?.[projectId] ?? [];
  const globalOrder = placement.machineOrder ?? [LOCAL_AGENT_MACHINE];
  const override = placement.projectMachineOrders?.[projectId];
  const order = override ?? globalOrder;
  const options = singleAgentMachineOptions(placement);
  const label = (id: string) => options.find((machine) => machine.value === id)?.label ?? id;
  const save = (next: readonly string[]) =>
    update(projectId ? { projectMachineOrders: { [projectId]: next } } : { machineOrder: next });
  const move = (index: number, delta: number) => {
    const next = [...order];
    next.splice(index + delta, 0, ...next.splice(index, 1));
    save(next);
  };
  const available = options.filter(({ value }) => !order.includes(value));
  return (
    <div className="space-y-2 px-3 py-2.5 text-xs sm:px-4">
      <label className="flex items-center justify-between gap-2">
        Machine priority
        <select
          className="rounded border bg-background p-1"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground">
        {projectId && override === undefined
          ? "Using the global order. Edit the list to override it for this Project."
          : "New agents use the first ready machine in this list."}
      </p>
      {projectId && (
        <fieldset className="flex flex-wrap gap-3">
          <legend>Required integrations</legend>
          {AgentIntegration.literals.map((key) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={required.includes(key)}
                onChange={(event) =>
                  update({
                    projectRequirements: {
                      [projectId]: event.target.checked
                        ? [...required, key]
                        : required.filter((value) => value !== key),
                    },
                  })
                }
              />
              {
                {
                  gh: "GitHub CLI",
                  sentry: "Sentry",
                  readReplica: "Read replica",
                  eas: "EAS",
                  vercel: "Vercel",
                  posthog: "PostHog",
                  mcp: "MCP",
                }[key]
              }
            </label>
          ))}
        </fieldset>
      )}
      <ol className="list-inside list-decimal">
        {order.map((id, index) => (
          <li key={id} className="py-1">
            {label(id)}
            <span className="float-right flex gap-2">
              <button
                disabled={index === 0}
                aria-label={`Move ${label(id)} up`}
                onClick={() => move(index, -1)}
              >
                Up
              </button>
              <button
                disabled={index === order.length - 1}
                aria-label={`Move ${label(id)} down`}
                onClick={() => move(index, 1)}
              >
                Down
              </button>
              <button
                disabled={order.length === 1}
                aria-label={`Remove ${label(id)} from order`}
                onClick={() => save(order.filter((machine) => machine !== id))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      {available.length > 0 && (
        <select
          className="rounded border bg-background p-1"
          aria-label="Add machine to priority order"
          value=""
          onChange={(event) => save([...order, event.target.value])}
        >
          <option value="" disabled>
            Add machine to order
          </option>
          {available.map(({ value, label }) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      )}
      {projectId && override !== undefined && (
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => update({ projectMachineOrders: { [projectId]: null } })}
        >
          Use global order
        </Button>
      )}
    </div>
  );
}

function AgentMachinesSection({
  environment,
  placement,
}: {
  readonly environment: EnvironmentPresentation;
  readonly placement: AgentPlacementSettings;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  const update = useCallback(
    (patch: AgentPlacementSettingsPatch | null) => {
      if (patch !== null) updateSettings({ agentPlacement: patch });
    },
    [updateSettings],
  );
  const { id, title } = searchableSetting("agent-machines");
  return (
    <FoldedSettingsSection id={id} title={title} summary={summarizeAgentPlacement(placement)}>
      <AgentMachinesBody environment={environment} placement={placement} update={update} />
    </FoldedSettingsSection>
  );
}

export interface AgentMachinesCheckState {
  readonly phase: "checking" | "done" | "failed";
  readonly statuses: ReadonlyMap<string, AgentMachineStatus>;
  /** When `statuses` arrived; token expiry is measured from here, not from render. */
  readonly checkedAt: number;
  readonly waitingAgents?: AgentMachinesResult["waitingAgents"];
  readonly error?: string;
}

function checkedState(result: AgentMachinesResult): AgentMachinesCheckState {
  return {
    phase: "done",
    statuses: agentMachineStatusesById(result.machines),
    waitingAgents: result.waitingAgents,
    checkedAt: Date.now(),
  };
}

/** Mounts when the fold opens, so each opening checks the machines once. */
function AgentMachinesBody({
  environment,
  placement,
  update,
}: {
  readonly environment: EnvironmentPresentation;
  readonly placement: AgentPlacementSettings;
  readonly update: (patch: AgentPlacementSettingsPatch | null) => void;
}) {
  const environmentId = environment.environmentId;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.assistant?.archivedAt == null,
  );
  const agentMachines = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const { environments } = useEnvironments();
  const [check, setCheck] = useState<AgentMachinesCheckState>({
    phase: "checking",
    statuses: new Map(),
    checkedAt: 0,
  });
  const latestCheck = useRef(0);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [linkBackTarget, setLinkBackTarget] = useState<{ id: string; label: string } | null>(null);
  const [relinkTarget, setRelinkTarget] = useState<LinkedAgentMachine | null>(null);
  const [createLinkOpen, setCreateLinkOpen] = useState(false);
  const [relinking, setRelinking] = useState<string | null>(null);
  const agentMachinePairing = useAtomCommand(serverEnvironment.agentMachinePairing, {
    reportFailure: false,
  });
  const selfAddress = useSelfAddress(environmentId, true);

  // Starts in "checking"; the caller sets that phase for a manual refresh.
  const requestCheck = useCallback(async () => {
    const generation = ++latestCheck.current;
    const result = await agentMachines({ environmentId, input: { action: "check" } });
    if (generation !== latestCheck.current) return;
    if (result._tag === "Success") {
      setCheck(checkedState(result.value));
    } else if (!isAtomCommandInterrupted(result)) {
      setCheck((previous) => ({
        ...previous,
        phase: "failed",
        error: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      }));
    }
  }, [agentMachines, environmentId]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The check RPC is the external system; its state lands only after the await.
    void requestCheck();
  }, [requestCheck]);

  const refresh = () => {
    setCheck((previous) => ({ ...previous, phase: "checking" }));
    void requestCheck();
  };

  const afterLinkChange = (result: AgentMachinesResult) => {
    if (result.waitingAgents !== undefined) {
      latestCheck.current++;
      setCheck(checkedState(result));
      return;
    }
    // Link operations return machine statuses. Refresh eligibility against the changed links.
    setCheck((previous) => ({
      ...checkedState(result),
      phase: "checking",
      waitingAgents: previous.waitingAgents,
    }));
    void requestCheck();
  };

  const resume = async (agent: WaitingAgent, destinationId?: string) => {
    if (
      resumingId !== null ||
      check.phase !== "done" ||
      !(destinationId
        ? agent.destinations?.some((item) => item.id === destinationId)
        : agent.canResume)
    )
      return;
    setResumingId(agent.threadId);
    try {
      const result = await agentMachines({
        environmentId,
        input: {
          action: agent.recoveryLabel && !destinationId ? "recoverHandoff" : "resume",
          threadId: agent.threadId,
          waitId: agent.waitId,
          ...(destinationId ? { destinationId } : {}),
        },
      });
      if (result._tag === "Success") {
        latestCheck.current++;
        setCheck(checkedState(result.value));
        toastManager.add({
          type: "success",
          title:
            agent.recoveryLabel && !destinationId
              ? `Handoff cancelled. Review ${agent.title} before resuming.`
              : `Resumed ${agent.title} on ${agent.destinations?.find((item) => item.id === destinationId)?.label ?? agent.machineLabel}`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not resume ${agent.title}`,
          description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
        });
        await requestCheck();
      }
    } finally {
      setResumingId(null);
    }
  };

  /**
   * One click when this window is also connected to that machine: it mints a
   * pairing link there and relinks both ways. Otherwise the pairing dialog
   * opens for that machine, so only the link needs pasting.
   */
  const relink = async (machine: LinkedAgentMachine) => {
    const connected = environments.some((candidate) => candidate.environmentId === machine.id);
    if (!connected) {
      setRelinkTarget(machine);
      return;
    }
    setRelinking(machine.id);
    const pairing = await agentMachinePairing({
      environmentId: machine.id as EnvironmentId,
      input: { baseUrl: machine.baseUrl, label: environment.label, holderId: environmentId },
    });
    if (pairing._tag !== "Success") {
      setRelinking(null);
      setRelinkTarget(machine);
      return;
    }
    const linked = await agentMachines({
      environmentId,
      input: agentMachineLinkInput(pairing.value.pairingUrl, machine.baseUrl, machine.id),
    });
    if (linked._tag !== "Success") {
      setRelinking(null);
      if (!isAtomCommandInterrupted(linked)) {
        toastManager.add({
          type: "error",
          title: `Could not relink ${machine.label}`,
          description: agentMachinesErrorMessage(squashAtomCommandFailure(linked)),
        });
      }
      return;
    }
    afterLinkChange(linked.value);
    const back =
      selfAddress === null
        ? null
        : await agentMachines({
            environmentId,
            input: { action: "linkBack", id: machine.id, baseUrl: selfAddress },
          });
    setRelinking(null);
    if (back !== null && back._tag === "Success") afterLinkChange(back.value);
    toastManager.add(
      back !== null && back._tag === "Success"
        ? { type: "success", title: `Relinked ${machine.label} both ways` }
        : {
            type: "warning",
            title: `Relinked ${machine.label}, but not back`,
            description: `Use "Let ${machine.label} reach this machine" from its menu.`,
          },
    );
  };

  const unlink = async (machineId: string, label: string) => {
    setUnlinking(machineId);
    const result = await agentMachines({
      environmentId,
      input: { action: "unlink", id: machineId },
    });
    setUnlinking(null);
    if (result._tag === "Success") {
      afterLinkChange(result.value);
      toastManager.add({
        type: "success",
        title: `Unlinked ${label}`,
        description: `Access between ${environment.label} and ${label} was revoked. A link older than automatic renewal can stay in Settings → Connections until it expires; remove it there to end it now.`,
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not unlink ${label}`,
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <>
      <AgentMachinesView
        environmentLabel={environment.label}
        localKind={resolveEnvironmentMachineKind(environment.serverConfig)}
        localSubtitle={environmentTransportLabel(environment)}
        machineKind={(machineId) =>
          resolveEnvironmentMachineKind(
            environments.find((candidate) => candidate.environmentId === machineId)?.serverConfig ??
              null,
          )
        }
        placement={placement}
        projects={projects}
        check={check}
        resumingId={resumingId}
        onResume={(agent, id) => void resume(agent, id)}
        unlinking={unlinking}
        update={update}
        onRefresh={refresh}
        onAdd={() => setAddOpen(true)}
        onUnlink={(machineId, label) => void unlink(machineId, label)}
        onLinkBack={(id, label) => setLinkBackTarget({ id, label })}
        relinking={relinking}
        onRelink={(machine) => void relink(machine)}
        onCreateLink={() => setCreateLinkOpen(true)}
      />
      <CreateMachineLinkDialog
        open={createLinkOpen}
        onClose={() => setCreateLinkOpen(false)}
        environmentId={environmentId}
        environmentLabel={environment.label}
        selfAddress={selfAddress}
      />
      <LinkBackDialog
        target={linkBackTarget}
        onClose={() => setLinkBackTarget(null)}
        environmentId={environmentId}
        environmentLabel={environment.label}
        onLinked={afterLinkChange}
      />
      <AddAgentMachineDialog
        open={addOpen || relinkTarget !== null}
        relink={relinkTarget}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setRelinkTarget(null);
        }}
        environmentId={environmentId}
        environmentLabel={environment.label}
        onLinked={afterLinkChange}
      />
    </>
  );
}

/**
 * The open section's rows, from props only so it can be rendered against a
 * fixture. `AgentMachinesBody` owns the RPC state.
 */
const noProjects = [] as const;
const noLinkBack = () => {};
const noRelink = () => {};
const noCreateLink = () => {};

export function AgentMachinesView({
  environmentLabel,
  localKind,
  localSubtitle,
  projects = noProjects,
  machineKind,
  placement,
  check,
  resumingId = null,
  onResume,
  unlinking,
  update,
  onRefresh,
  onAdd,
  onUnlink,
  onLinkBack = noLinkBack,
  relinking = null,
  onRelink = noRelink,
  onCreateLink = noCreateLink,
}: {
  readonly environmentLabel: string;
  readonly localKind: EnvironmentMachineKind;
  readonly localSubtitle: ReactNode;
  readonly projects?: ReadonlyArray<{ id: string; title: string }>;
  readonly machineKind: (machineId: string) => EnvironmentMachineKind;
  readonly placement: AgentPlacementSettings;
  readonly check: AgentMachinesCheckState;
  readonly resumingId?: string | null;
  readonly onResume?: (agent: WaitingAgent, destinationId?: string) => void;
  readonly unlinking: string | null;
  readonly update: (patch: AgentPlacementSettingsPatch | null) => void;
  readonly onRefresh: () => void;
  readonly onAdd: () => void;
  readonly onUnlink: (machineId: string, label: string) => void;
  readonly onLinkBack?: (machineId: string, label: string) => void;
  readonly relinking?: string | null;
  readonly onRelink?: (machine: LinkedAgentMachine) => void;
  readonly onCreateLink?: () => void;
}) {
  const balanced = placement.mode === "balanced";
  const machines = linkedAgentMachines(placement);
  const checking = check.phase === "checking";

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Where coordinators on {environmentLabel} start new agents. A linked machine needs the same
          Project to take an agent.
        </p>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={checking || resumingId !== null}
          onClick={onRefresh}
          aria-label="Refresh machine status"
        >
          <RefreshIcon refreshing={checking} className="size-3" />
          Refresh
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={onCreateLink}>
          Create link
        </Button>
        <Button size="xs" variant="outline" onClick={onAdd}>
          <PlusIcon className="size-3" />
          Add machine
        </Button>
      </div>
      {check.phase === "failed" ? (
        <p role="status" className="px-3 py-2.5 text-xs text-destructive sm:px-4">
          Could not check machines: {check.error}
        </p>
      ) : null}
      {check.waitingAgents?.length ? (
        <WaitingAgentsSettings
          agents={check.waitingAgents}
          fresh={check.phase === "done"}
          resumingId={resumingId}
          onResume={onResume}
        />
      ) : null}
      <SettingLine label="Where new agents run">
        <Select
          items={agentPlacementModeOptions}
          value={placement.mode}
          onValueChange={(value) => {
            if (value !== null && isAgentPlacementMode(value)) update({ mode: value });
          }}
        >
          <SelectTrigger size="xs" className="w-48" aria-label="Where new agents run">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {agentPlacementModeOptions.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingLine>
      {placement.mode === "priority" ? (
        <MachinePrioritySettings placement={placement} projects={projects} update={update} />
      ) : null}
      {placement.mode === "single" ? (
        <SettingLine label="Machine">
          <Select
            items={singleAgentMachineOptions(placement)}
            value={singleAgentMachineValue(placement)}
            onValueChange={(value) => {
              if (value !== null) update({ singleMachineId: value });
            }}
          >
            <SelectTrigger size="xs" className="w-48" aria-label="Machine for new agents">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {singleAgentMachineOptions(placement).map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingLine>
      ) : null}
      {placement.mode !== "priority" && (
        <SettingLine
          label="Use this machine if no other is available"
          description="An agent sent to a named machine never falls back."
        >
          <Switch
            aria-label="Use this machine if no other is available"
            checked={placement.allowLocalFallback}
            disabled={placement.mode === "local"}
            onCheckedChange={(allowLocalFallback) => update({ allowLocalFallback })}
          />
        </SettingLine>
      )}
      <EnvironmentRow kind={localKind} label={environmentLabel} subtitle={localSubtitle}>
        <PreferenceSelect
          label={environmentLabel}
          value={placement.localPreference}
          disabled={!balanced}
          onChange={(localPreference) => update({ localPreference })}
        />
        {/* Keeps the preference column aligned with the linked rows' menu button. */}
        <span aria-hidden className="size-8 sm:size-7" />
      </EnvironmentRow>
      {machines.map((machine) => {
        const status = check.statuses.get(machine.id);
        const presentation = checking
          ? { label: "Checking…", tone: "muted" as const }
          : agentMachineStatusPresentation(status, check.checkedAt);
        const matches = projectMatchText(status);
        const renewalLine = checking ? null : tokenRenewalText(status, check.checkedAt);
        const needsRelink = !checking && agentMachineNeedsRelink(status);
        return (
          <EnvironmentRow
            key={machine.id}
            kind={machineKind(machine.id)}
            label={machine.label}
            dimmed={!machine.enabled}
            subtitle={
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agentMachineStatusDotClassName(presentation.tone),
                  )}
                />
                <span className="truncate">
                  {presentation.label}
                  {matches ? ` · ${matches}` : ""}
                </span>
              </span>
            }
            below={
              (status?.detail && status.status !== "connected") || renewalLine !== null ? (
                <div className="grid gap-0.5">
                  {status?.detail && status.status !== "connected" ? (
                    <p className="text-xs break-words text-muted-foreground/70">{status.detail}</p>
                  ) : null}
                  {renewalLine !== null ? (
                    <p className="text-xs break-words text-muted-foreground/70">{renewalLine}</p>
                  ) : null}
                </div>
              ) : null
            }
          >
            {needsRelink ? (
              <Button
                size="xs"
                variant="outline"
                disabled={relinking !== null}
                onClick={() => onRelink(machine)}
              >
                {relinking === machine.id ? "Relinking…" : "Relink"}
              </Button>
            ) : null}
            <Switch
              aria-label={`Start agents on ${machine.label}`}
              checked={machine.enabled}
              onCheckedChange={(enabled) =>
                update(agentMachineEntryPatch(placement, machine.id, { enabled }))
              }
            />
            <PreferenceSelect
              label={machine.label}
              value={machine.preference}
              disabled={!balanced || !machine.enabled}
              onChange={(preference) =>
                update(agentMachineEntryPatch(placement, machine.id, { preference }))
              }
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={unlinking !== null}
                    aria-label={`${machine.label} options`}
                  />
                }
              >
                <MoreVertical />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => onRelink(machine)}>Relink</MenuItem>
                <MenuItem onClick={() => onLinkBack(machine.id, machine.label)}>
                  Let {machine.label} reach this machine
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => onUnlink(machine.id, machine.label)}>
                  Unlink
                </MenuItem>
              </MenuPopup>
            </Menu>
          </EnvironmentRow>
        );
      })}
      {machines.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          No linked machines. Add one to start agents on it.
        </p>
      ) : null}
    </>
  );
}

function SettingLine({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function PreferenceSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: AgentMachinePreference;
  readonly disabled: boolean;
  readonly onChange: (value: AgentMachinePreference) => void;
}) {
  return (
    <Select
      items={loadPreferences}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="xs" className="w-32" aria-label={`${label} agent preference`}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {loadPreferences.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function AddAgentMachineDialog({
  open,
  relink = null,
  onOpenChange,
  environmentId,
  environmentLabel,
  onLinked,
}: {
  readonly open: boolean;
  /** Relinking this machine: its address is used and a link for any other machine is refused. */
  readonly relink?: LinkedAgentMachine | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onLinked: (result: AgentMachinesResult) => void;
}) {
  const agentMachines = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkBack, setLinkBack] = useState(true);
  const suggested = useSelfAddress(environmentId, open);
  const [selfAddress, setSelfAddress] = useState<string | null>(null);
  const address = (selfAddress ?? suggested ?? "").trim();
  const canSubmit = pairingUrl.trim().length > 0 && !busy && (!linkBack || address.length > 0);

  const close = () => {
    setPairingUrl("");
    setBaseUrl("");
    setSelfAddress(null);
    onOpenChange(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const result = await agentMachines({
      environmentId,
      input: agentMachineLinkInput(
        pairingUrl,
        baseUrl.trim().length > 0 ? baseUrl : (relink?.baseUrl ?? ""),
        relink?.id,
      ),
    });
    if (result._tag === "Success") {
      onLinked(result.value);
      const linked = result.value.linked;
      if (linkBack && linked !== undefined) {
        const back = await agentMachines({
          environmentId,
          input: { action: "linkBack", id: linked.id, baseUrl: address },
        });
        setBusy(false);
        if (back._tag === "Success") {
          onLinked(back.value);
          toastManager.add({
            type: "success",
            title: `Linked ${linked.label} both ways`,
            description: `${environmentLabel} and ${linked.label} can now reach each other: agents, and the Assistant on either machine.`,
          });
        } else if (!isAtomCommandInterrupted(back)) {
          toastManager.add({
            type: "warning",
            title: `Linked ${linked.label}, but not back`,
            description: `${agentMachinesErrorMessage(squashAtomCommandFailure(back))} You can retry from the machine's menu.`,
          });
        }
        close();
        return;
      }
      setBusy(false);
      toastManager.add({
        type: "success",
        title: linked ? `Linked ${linked.label}` : "Machine linked",
        description: `Coordinators on ${environmentLabel} can now start agents there.`,
      });
      close();
    } else if (!isAtomCommandInterrupted(result)) {
      setBusy(false);
      toastManager.add({
        type: "error",
        title: "Could not link machine",
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {relink === null ? "Add a machine for agents" : `Relink ${relink.label}`}
          </DialogTitle>
          <DialogDescription>
            {relink === null ? "On the other machine" : `On ${relink.label}`}, open Settings →
            Connections → Agent machines → Create link, or run <code>t3 pair --machine-link</code>.
            Add <code>--tailscale</code> if you want to use a Tailscale address. Paste the link
            here. A general pairing link also works and requires manual renewal.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="agent-machine-pairing-url">Pairing link</Label>
              <Input
                id="agent-machine-pairing-url"
                placeholder="Paste the pairing link from the other machine"
                autoComplete="off"
                value={pairingUrl}
                onChange={(event) => setPairingUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-machine-base-url">Address (optional)</Label>
              <Input
                id="agent-machine-base-url"
                placeholder={
                  relink === null
                    ? "Use when the link's address is not reachable from here"
                    : relink.baseUrl
                }
                autoComplete="off"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Switch
                aria-label={`Let that machine reach ${environmentLabel} too`}
                checked={linkBack}
                onCheckedChange={setLinkBack}
              />
              <span className="grid gap-0.5">
                <span>Let that machine reach {environmentLabel} too</span>
                <span className="text-xs text-muted-foreground">
                  Needed for the Assistant and coordinators to reach each other across machines.
                </span>
              </span>
            </label>
            {linkBack ? (
              <div className="grid gap-1.5">
                <Label htmlFor="agent-machine-self-url">
                  {environmentLabel}'s address, as that machine reaches it
                </Label>
                <Input
                  id="agent-machine-self-url"
                  placeholder="URL the other machine can use to reach this one"
                  autoComplete="off"
                  value={selfAddress ?? suggested ?? ""}
                  onChange={(event) => setSelfAddress(event.target.value)}
                />
                {suggested === null ? (
                  <p className="text-xs text-muted-foreground">
                    {environmentLabel} only listens on this computer. Turn on network access in
                    Settings, Connections, then enter its tailnet or network address.
                  </p>
                ) : null}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Linking lets {environmentLabel} run agents on that machine with its full access.
              Access renews automatically while both machines are online.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Linking…" : "Link machine"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** This machine's best guess at its own address as a linked machine reaches it; null when it listens on loopback only. */
function useSelfAddress(environmentId: EnvironmentId, open: boolean): string | null {
  const assistantHome = useAtomCommand(serverEnvironment.assistantHome, { reportFailure: false });
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void assistantHome({ environmentId, input: { action: "status" } }).then((result) => {
      if (!cancelled && result._tag === "Success") setAddress(result.value.addresses[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantHome, environmentId, open]);
  return address;
}

function LinkBackDialog({
  target,
  onClose,
  environmentId,
  environmentLabel,
  onLinked,
}: {
  readonly target: { readonly id: string; readonly label: string } | null;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onLinked: (result: AgentMachinesResult) => void;
}) {
  const agentMachines = useAtomCommand(serverEnvironment.agentMachines, { reportFailure: false });
  const suggested = useSelfAddress(environmentId, target !== null);
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const address = (edited ?? suggested ?? "").trim();

  const close = () => {
    setEdited(null);
    onClose();
  };

  const submit = async () => {
    if (target === null || address.length === 0) return;
    setBusy(true);
    const result = await agentMachines({
      environmentId,
      input: { action: "linkBack", id: target.id, baseUrl: address },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onLinked(result.value);
      toastManager.add({
        type: "success",
        title: `${target.label} can reach ${environmentLabel}`,
        description: "The Assistant and coordinators on either machine can now reach each other.",
      });
      close();
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not link ${target.label} back`,
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Let {target?.label} reach {environmentLabel}
          </DialogTitle>
          <DialogDescription>
            {target?.label} links {environmentLabel} with a one-time pairing link this machine
            creates, so the Assistant and coordinators on either machine can reach each other.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-1.5">
            <Label htmlFor="agent-machine-link-back-url">
              {environmentLabel}'s address, as {target?.label} reaches it
            </Label>
            <Input
              id="agent-machine-link-back-url"
              placeholder="URL the other machine can use to reach this one"
              autoComplete="off"
              value={edited ?? suggested ?? ""}
              onChange={(event) => setEdited(event.target.value)}
              autoFocus
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || address.length === 0}>
            {busy ? "Linking…" : "Link back"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Mints a machine link on this machine for another one to paste under Add
 * machine: read and operate only, and renewable (a general pairing link is not).
 */
function CreateMachineLinkDialog({
  open,
  onClose,
  environmentId,
  environmentLabel,
  selfAddress,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly selfAddress: string | null;
}) {
  const agentMachinePairing = useAtomCommand(serverEnvironment.agentMachinePairing, {
    reportFailure: false,
  });
  const [edited, setEdited] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const address = (edited ?? selfAddress ?? "").trim();

  const close = () => {
    setEdited(null);
    setLink(null);
    onClose();
  };

  const create = async () => {
    if (address.length === 0) return;
    setBusy(true);
    const result = await agentMachinePairing({
      environmentId,
      input: { baseUrl: address, label: "a linked machine" },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setLink(result.value.pairingUrl);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not create a machine link",
        description: agentMachinesErrorMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a machine link</DialogTitle>
          <DialogDescription>
            Paste it under Add machine on the other machine within 10 minutes. It lets that machine
            run agents on {environmentLabel}, and its access renews automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-machine-create-link-address">
                {environmentLabel}'s address, as the other machine reaches it
              </Label>
              <Input
                id="agent-machine-create-link-address"
                placeholder="URL the other machine can use to reach this one"
                autoComplete="off"
                value={edited ?? selfAddress ?? ""}
                onChange={(event) => {
                  setEdited(event.target.value);
                  setLink(null);
                }}
              />
            </div>
            {link !== null ? (
              <div className="grid gap-1.5">
                <Label htmlFor="agent-machine-created-link">Machine link</Label>
                <Input
                  id="agent-machine-created-link"
                  readOnly
                  value={link}
                  onFocus={(event) => event.target.select()}
                />
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            {link === null ? "Cancel" : "Done"}
          </Button>
          {link === null ? (
            <Button onClick={() => void create()} disabled={busy || address.length === 0}>
              {busy ? "Creating…" : "Create link"}
            </Button>
          ) : (
            <Button onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
