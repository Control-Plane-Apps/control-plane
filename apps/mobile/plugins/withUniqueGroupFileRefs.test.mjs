import { describe, expect, it } from "vitest";
import plugin from "./withUniqueGroupFileRefs.cjs";

const { dedupeGroupFileRefs } = plugin;

const project = `/* Begin PBXFileReference section */
\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
/* End PBXFileReference section */
\t\tBBBBBBBBBBBBBBBBBBBBBBBB /* expo-sharing-extension */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Info.plist */,
\t\t\t);
\t\t};
\t\tCCCCCCCCCCCCCCCCCCCCCCCC /* ExpoWidgetsTarget */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\tAAAAAAAAAAAAAAAAAAAAAAAA /* Info.plist */,
\t\t\t);
\t\t};
`;

describe("withUniqueGroupFileRefs", () => {
  it("gives a file reference shared by two groups a copy in the second", () => {
    const next = dedupeGroupFileRefs(project);
    const refs = [
      ...next.matchAll(/\t\t([0-9A-F]{24}) \/\* Info.plist \*\/ = \{isa = PBXFileReference/g),
    ];
    expect(refs).toHaveLength(2);
    const members = [...next.matchAll(/\t\t\t\t([0-9A-F]{24}) \/\* Info.plist \*\/,/g)].map(
      (m) => m[1],
    );
    expect(new Set(members).size).toBe(2);
    expect(members[0]).toBe("AAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("leaves a project without shared references unchanged and is idempotent", () => {
    const once = dedupeGroupFileRefs(project);
    expect(dedupeGroupFileRefs(once)).toBe(once);
  });
});
