// Fork-owned. expo-widgets and expo-sharing each add their extension's
// Info.plist to the Xcode project through the `xcode` package, which reuses an
// existing file reference with the same path ("Info.plist"). Both extension
// groups then list the same reference, and Xcode 27 refuses to open the
// project ("The reference "Info.plist" is a member of more than one group").
// After every other mod has written the project, give each extra membership
// its own file reference. Build settings point at the plists by path, so the
// build is unchanged.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { withFinalizedMod } = require("expo/config-plugins");

const GROUP_PATTERN =
  /(\t\t([0-9A-F]{24}) \/\* [^*]* \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)([\s\S]*?)(\t\t\t\);)/g;
const CHILD_PATTERN = /\t\t\t\t([0-9A-F]{24}) \/\* ([^*]*) \*\/,\n/g;

function newId(seed) {
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 24).toUpperCase();
}

/** Returns the project text with every file reference in at most one group. */
function dedupeGroupFileRefs(text) {
  const fileRefs = new Map();
  for (const match of text.matchAll(
    /\t\t([0-9A-F]{24}) \/\* [^*]* \*\/ = \{isa = PBXFileReference;[^\n]*\n/g,
  )) {
    fileRefs.set(match[1], match[0]);
  }
  const seen = new Set();
  const added = [];
  const result = text.replace(GROUP_PATTERN, (whole, head, groupId, children, tail) => {
    const nextChildren = children.replace(CHILD_PATTERN, (line, childId, comment) => {
      if (!fileRefs.has(childId)) return line;
      if (!seen.has(childId)) {
        seen.add(childId);
        return line;
      }
      const copyId = newId(`${groupId}:${childId}`);
      added.push(fileRefs.get(childId).replace(childId, copyId));
      return `\t\t\t\t${copyId} /* ${comment} */,\n`;
    });
    return `${head}${nextChildren}${tail}`;
  });
  if (added.length === 0) return text;
  return result.replace(
    "/* Begin PBXFileReference section */\n",
    `/* Begin PBXFileReference section */\n${added.join("")}`,
  );
}

function withUniqueGroupFileRefs(config) {
  return withFinalizedMod(config, [
    "ios",
    (modConfig) => {
      const iosRoot = modConfig.modRequest.platformProjectRoot;
      for (const entry of fs.readdirSync(iosRoot)) {
        if (!entry.endsWith(".xcodeproj")) continue;
        const projectFile = path.join(iosRoot, entry, "project.pbxproj");
        if (!fs.existsSync(projectFile)) continue;
        const text = fs.readFileSync(projectFile, "utf8");
        const next = dedupeGroupFileRefs(text);
        if (next !== text) fs.writeFileSync(projectFile, next);
      }
      return modConfig;
    },
  ]);
}

module.exports = withUniqueGroupFileRefs;
module.exports.dedupeGroupFileRefs = dedupeGroupFileRefs;
