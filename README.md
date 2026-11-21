# Quiet reconnect simulator evidence

Final source: eb5176d50d55ca2d3164bd2507161ec42bc21f8c
Native: local matching development client, fingerprint cf7f77cc9d727a9f38e4acfcbc4e274816e49be8, iOS 26.5, disposable iPhone 17 Pro simulator.

Actual normal app paired to a fresh synthetic local server and loaded the React workspace and thread. The server was then stopped. No live user database was copied. No connection/network props were forced. Cached rows persisted across process termination and launch.

- before-policy-cached-1.5s.png: original 800ms/all-environment header policy from base 5e571ccf35 (WorkspaceConnectionTitle.tsx and workspace-connection-status.ts), with hook renamed/exported for the current native Home title. Shows Reconnecting at 1.972 seconds after cached rows were first observed. This is a controlled policy comparison on the current iPhone surface, not a full historical build.
- native-final-cached-first.png: final source, cached rows visible without connection title. Captured 0.641 seconds after cached rows were first observed.
- native-final-persistent-6.5s.png: final source, genuine stopped-server connection failure title visible with the same cached rows, captured 7.139 seconds after cached rows were first observed.
- final-cold-launch.mp4: complete final development-client cold launch and delayed persistent failure title.

The development client downloads/starts JS before the app renders. Final cached rows were first observed 13.232 seconds after native process launch; screenshot timing is relative to that observed content readiness, not native launch. The first screenshot is unaltered and the exact 5-second boundary is verified by fake-timer unit tests.

Phone-wide loss of network was not simulated or claimed. Stopping the actual server proves an unreachable Mac/server case. Offline promptness is covered by unit tests; no host network change affected the protected device. All temporary policy edits were restored byte-for-byte.
