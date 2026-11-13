import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PillButton } from "../status/ProjectStatusPanel";
import { cloudErrorMessage, cloudTaskStore } from "./cloudTasks";
import { useCloudTasks } from "./useMobileTasks";

// Fork-owned. Settings > Task Sync on the phone: sign in to the Control Plane
// account so Tasks keep working while the Mac sleeps. No purchase on iOS; the
// subscription is managed from the Mac.

function formatWhen(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

const INPUT_CLASS =
  "min-h-11 rounded-xl border border-input-border bg-input px-3 text-[17px] text-foreground";

export function TaskSyncSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { status } = useCloudTasks();
  const store = cloudTaskStore();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening this screen asks again whether Task Sync is switched on.
  useEffect(() => {
    void store.recheck(0);
  }, [store]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(cloudErrorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const state = status?.state ?? "signed-out";
  const lastSynced = formatWhen(status?.lastSyncedAt);

  let body;
  if (state === "coming-soon") {
    body = (
      <View className="gap-2">
        <Text className="text-[17px] font-semibold text-foreground">Task Sync is coming soon</Text>
        <Text className="text-[15px] text-foreground-muted">
          Task Sync will keep your tasks on this phone while your Mac sleeps. Until then your tasks
          come through your Mac.
        </Text>
      </View>
    );
  } else if (state === "unavailable") {
    body = (
      <Text className="text-[15px] text-foreground-muted">
        Task Sync isn't available in this build of Control Plane.
      </Text>
    );
  } else if (state === "signed-out") {
    body = (
      <View className="gap-3">
        <Text className="text-[15px] text-foreground-muted">
          Sign in with your Control Plane account to keep Tasks working while your Mac sleeps.
        </Text>
        {codeSentTo === null ? (
          <>
            <AppTextInput
              accessibilityLabel="Email for your Control Plane account"
              className={INPUT_CLASS}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
            />
            <PillButton
              label="Send code"
              tone="primary"
              disabled={busy || email.trim().length === 0}
              onPress={() => {
                void run(() => store.requestCode(email.trim())).then((ok) => {
                  if (ok) setCodeSentTo(email.trim());
                });
              }}
            />
          </>
        ) : (
          <>
            <Text className="text-[15px] text-foreground-muted">
              We sent a 6-digit code to {codeSentTo}.
            </Text>
            <AppTextInput
              accessibilityLabel="Sign-in code"
              className={INPUT_CLASS}
              placeholder="123456"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChangeText={setCode}
            />
            <View className="flex-row flex-wrap gap-2">
              <PillButton
                label="Sign in"
                tone="primary"
                disabled={busy || code.trim().length < 6}
                onPress={() => void run(() => store.verify(codeSentTo, code.trim()))}
              />
              <PillButton
                label="Use a different email"
                tone="secondary"
                onPress={() => {
                  setCodeSentTo(null);
                  setCode("");
                }}
              />
            </View>
          </>
        )}
      </View>
    );
  } else if (state === "inactive") {
    body = (
      <View className="gap-3">
        <Text className="text-[17px] font-semibold text-foreground">Turn on Task Sync</Text>
        <Text className="text-[15px] text-foreground-muted">
          Task Sync isn't on for {status?.account?.email ?? "this account"}. Turn it on in Control
          Plane on your Mac under Settings, Task Sync. Tasks still come through your Mac.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <PillButton
            label="Check again"
            tone="secondary"
            disabled={busy}
            onPress={() => void run(() => store.syncNow())}
          />
          <PillButton
            label="Sign out"
            tone="secondary"
            disabled={busy}
            onPress={() => void run(() => store.signOut())}
          />
        </View>
      </View>
    );
  } else {
    const grace = status?.subscription?.status === "grace";
    body = (
      <View className="gap-3">
        <Text className="text-[17px] font-semibold text-foreground">Task Sync is on</Text>
        {grace ? (
          <Text className="text-[15px] text-warning-foreground">
            Your last payment didn't go through. Update your payment method from your Mac to keep
            syncing.
          </Text>
        ) : null}
        <Text className="text-[15px] text-foreground-muted">
          {state === "syncing"
            ? "Syncing…"
            : state === "error"
              ? status?.error
              : lastSynced !== null
                ? `Last synced ${lastSynced}.`
                : "Synced."}
          {status !== null && status.pendingChanges > 0
            ? ` ${status.pendingChanges} ${status.pendingChanges === 1 ? "change" : "changes"} waiting to sync.`
            : ""}
        </Text>
        <Text className="text-[15px] text-foreground-muted">
          {status?.account?.email}. Tasks work here while your Mac sleeps; links to threads and
          proposed tasks arrive when it wakes.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <PillButton
            label="Sync now"
            tone="secondary"
            icon="arrow.clockwise"
            disabled={busy}
            onPress={() => void run(() => store.syncNow())}
          />
          <PillButton
            label="Sign out"
            tone="secondary"
            disabled={busy}
            onPress={() => void run(() => store.signOut())}
          />
        </View>
      </View>
    );
  }

  return (
    <SettingsScreen title="Task Sync">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Control Plane account" card={false}>
          {body}
          {error !== null ? (
            <Text className="pt-2 text-[15px] text-danger-foreground">{error}</Text>
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
