// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - a one-off test setup script, plain Node.
// Links <caller> to <callee> the way agentMachines.link does: pairing credential
// exchanged for a read+operate token, descriptor id pinned, token in the
// caller's secret store, entry in the caller's settings. Run with both servers
// up; restart the caller afterwards so it reads the new settings.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  exchangePairingCredential,
  fetchPeerDescriptor,
} from "../../src/agentMachines/AgentMachineClient.ts";
import { agentMachineSecretName } from "../../src/agentMachines/AgentMachines.ts";

const [callerDir, calleeUrl, credential, label] = process.argv.slice(2);
const program = Effect.gen(function* () {
  const descriptor = yield* fetchPeerDescriptor(calleeUrl!);
  const exchanged = yield* exchangePairingCredential({
    baseUrl: calleeUrl!,
    credential: credential!,
    clientLabel: `Agent placement from ${label} test`,
  });
  return { descriptor, exchanged };
}).pipe(Effect.provide(FetchHttpClient.layer));

const { descriptor, exchanged } = await Effect.runPromise(program);
const secrets = `${callerDir}/userdata/secrets`;
NodeFS.writeFileSync(
  `${secrets}/${agentMachineSecretName(descriptor.environmentId)}.bin`,
  JSON.stringify({
    token: exchanged.token,
    expiresAt: new Date(Date.now() + exchanged.expiresInSeconds * 1000).toISOString(),
  }),
  { mode: 0o600 },
);
const settingsPath = `${callerDir}/userdata/settings.json`;
const settings = NodeFS.existsSync(settingsPath)
  ? JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))
  : {};
settings.agentPlacement = settings.agentPlacement ?? {};
settings.agentPlacement.machines = {
  ...settings.agentPlacement.machines,
  [descriptor.environmentId]: { label, baseUrl: calleeUrl, enabled: true, preference: 50 },
};
NodeFS.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(
  `linked ${callerDir} -> ${label} (${descriptor.environmentId}), token expires in ${exchanged.expiresInSeconds}s`,
);
