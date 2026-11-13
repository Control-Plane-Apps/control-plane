import type { TaskSyncStatus } from "@t3tools/contracts";
import { CloudIcon, RefreshCwIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { cn } from "../../lib/utils";
import { useTaskSync } from "../../state/taskSync";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function formatWhen(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function SignInForm(props: { readonly compact: boolean }) {
  const sync = useTaskSync();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await sync.requestCode(email.trim());
    if (result.ok) setCodeSentTo(email.trim());
    else if (result.message) setError(result.message);
  };
  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (codeSentTo === null) return;
    setError(null);
    const result = await sync.verify(codeSentTo, code.trim());
    if (!result.ok && result.message) setError(result.message);
  };

  return (
    <div className="flex flex-col gap-2">
      {codeSentTo === null ? (
        <form className="flex gap-2" onSubmit={sendCode}>
          <Input
            type="email"
            autoComplete="email"
            aria-label="Email for your Control Plane account"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={cn(props.compact ? "h-8" : "h-9", "min-w-0 flex-1")}
          />
          <Button
            type="submit"
            size={props.compact ? "sm" : "default"}
            disabled={sync.busy || email.trim().length === 0}
          >
            Send code
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={signIn}>
          <p className="text-muted-foreground text-xs">We sent a 6-digit code to {codeSentTo}.</p>
          <div className="flex gap-2">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Sign-in code"
              placeholder="123456"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={cn(
                props.compact ? "h-8" : "h-9",
                "min-w-0 flex-1 tabular-nums tracking-widest",
              )}
            />
            <Button
              type="submit"
              size={props.compact ? "sm" : "default"}
              disabled={sync.busy || code.trim().length < 6}
            >
              Sign in
            </Button>
          </div>
          <button
            type="button"
            className="self-start cursor-pointer text-muted-foreground text-xs hover:text-foreground"
            onClick={() => {
              setCodeSentTo(null);
              setCode("");
            }}
          >
            Use a different email
          </button>
        </form>
      )}
      {error !== null ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function AccountLine(props: { readonly status: TaskSyncStatus }) {
  const sync = useTaskSync();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      <span>Control Plane account</span>
      <span aria-hidden>·</span>
      <span className="text-foreground">{props.status.account?.email}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="cursor-pointer hover:text-foreground"
        disabled={sync.busy}
        onClick={() => void sync.signOut()}
      >
        Sign out
      </button>
    </p>
  );
}

/**
 * Sign-in, subscription and sync state for Task Sync. `compact` fits the
 * Tasks page aside; the full card sits in Settings.
 */
export function TaskSyncCard(props: { readonly compact?: boolean }) {
  const compact = props.compact === true;
  const sync = useTaskSync();
  const status = sync.status;
  const [error, setError] = useState<string | null>(null);
  if (status === null) return null;
  if (status.state === "unavailable") {
    return compact ? null : (
      <p className="text-muted-foreground text-sm">
        Task Sync isn't available in this build of Control Plane.
      </p>
    );
  }

  const title = cn(compact ? "text-sm" : "text-[15px]", "font-medium");
  const body = cn("text-muted-foreground", compact ? "text-xs" : "text-sm");
  const act = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null);
    const result = await run();
    if (!result.ok && result.message) setError(result.message);
  };

  if (status.state === "signed-out") {
    return (
      <section aria-label="Task Sync" className="flex flex-col gap-2">
        <h3 className={cn(title, "flex items-center gap-1.5")}>
          <CloudIcon aria-hidden className="size-4 text-muted-foreground" />
          Sign in to sync tasks
        </h3>
        <p className={body}>
          Sign in with your Control Plane account to keep tasks on all your devices, including your
          phone while this Mac sleeps.
        </p>
        <SignInForm compact={compact} />
      </section>
    );
  }

  if (status.state === "inactive") {
    return (
      <section aria-label="Task Sync" className="flex flex-col gap-2">
        <h3 className={title}>Turn on Task Sync</h3>
        <p className={body}>
          Task Sync keeps your tasks on every device for $5 a month. Your tasks stay on this Mac in
          the meantime.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size={compact ? "sm" : "default"}
            disabled={sync.busy}
            onClick={() => void act(sync.openCheckout)}
          >
            Subscribe
          </Button>
          <Button
            variant="outline"
            size={compact ? "sm" : "default"}
            disabled={sync.busy}
            onClick={() => void act(sync.syncNow)}
          >
            Check again
          </Button>
          {status.subscription?.canManage === true ? (
            <Button
              variant="outline"
              size={compact ? "sm" : "default"}
              disabled={sync.busy}
              onClick={() => void act(sync.openPortal)}
            >
              Manage billing
            </Button>
          ) : null}
        </div>
        <AccountLine status={status} />
        {error !== null ? <p className="text-destructive text-xs">{error}</p> : null}
      </section>
    );
  }

  // On the Tasks page only states that need the user show.
  if (compact && (status.state === "synced" || status.state === "syncing")) return null;
  const lastSynced = formatWhen(status.lastSyncedAt);
  const grace = status.subscription?.status === "grace";
  const renews = formatWhen(status.subscription?.currentPeriodEnd);
  return (
    <section aria-label="Task Sync" className="flex flex-col gap-2">
      <h3 className={cn(title, "flex items-center gap-1.5")}>
        <CloudIcon aria-hidden className="size-4 text-success-foreground" />
        Task Sync is on
      </h3>
      {grace ? (
        <p className={cn(body, "text-warning-foreground")}>
          Your last payment didn't go through. Update your payment method to keep syncing.
        </p>
      ) : null}
      <p className={body}>
        {status.state === "syncing"
          ? "Syncing…"
          : status.state === "error"
            ? status.error
            : lastSynced !== null
              ? `Last synced ${lastSynced}.`
              : "Synced."}
        {status.pendingChanges > 0
          ? ` ${status.pendingChanges} ${status.pendingChanges === 1 ? "change" : "changes"} waiting to sync.`
          : ""}
      </p>
      {!compact && renews !== null ? (
        <p className={body}>
          {status.subscription?.cancelAtPeriodEnd === true
            ? `Ends ${renews}.`
            : `Renews ${renews}.`}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size={compact ? "sm" : "default"}
          disabled={sync.busy}
          onClick={() => void act(sync.syncNow)}
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          Sync now
        </Button>
        {!compact ? (
          <Button
            variant={grace ? "default" : "outline"}
            disabled={sync.busy}
            onClick={() => void act(sync.openPortal)}
          >
            Manage subscription
          </Button>
        ) : null}
      </div>
      <AccountLine status={status} />
      {error !== null ? <p className="text-destructive text-xs">{error}</p> : null}
    </section>
  );
}
