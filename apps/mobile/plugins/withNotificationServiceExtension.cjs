// Fork-owned. Adds the CPNotificationService app extension (a Notification
// Service Extension) that gives each Status question notification its own
// answer button. Source: modules/cp-push-actions/notification-service.
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET = "CPNotificationService";
const SOURCE_DIR = path.join(__dirname, "..", "modules", "cp-push-actions", "notification-service");
const DEPLOYMENT_TARGET = "18.0";

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key>
  <string>${TARGET}</string>
  <key>CFBundleExecutable</key>
  <string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key>
  <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key>
  <string>XPC!</string>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>
</dict>
</plist>
`;
}

function withExtensionFiles(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const targetDir = path.join(modConfig.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(
        path.join(SOURCE_DIR, "NotificationService.swift"),
        path.join(targetDir, "NotificationService.swift"),
      );
      fs.writeFileSync(path.join(targetDir, "Info.plist"), infoPlist());
      return modConfig;
    },
  ]);
}

function hasTarget(project) {
  return Object.values(project.pbxNativeTargetSection()).some(
    (target) =>
      target && typeof target === "object" && String(target.name).replace(/"/g, "") === TARGET,
  );
}

function withExtensionTarget(config, bundleIdentifier) {
  return withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    if (hasTarget(project)) return modConfig;

    const marketingVersion = modConfig.version ?? "1.0";
    const buildNumber = modConfig.ios?.buildNumber ?? "1";
    const common = {
      CLANG_ENABLE_MODULES: "YES",
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: `"${buildNumber}"`,
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      IPHONEOS_DEPLOYMENT_TARGET: `"${DEPLOYMENT_TARGET}"`,
      LD_RUNPATH_SEARCH_PATHS: [
        '"$(inherited)"',
        '"@executable_path/Frameworks"',
        '"@executable_path/../../Frameworks"',
      ],
      MARKETING_VERSION: `${marketingVersion}`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}"`,
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      SKIP_INSTALL: "YES",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      ...(modConfig.ios?.appleTeamId ? { DEVELOPMENT_TEAM: modConfig.ios.appleTeamId } : {}),
    };
    const configurationList = project.addXCConfigurationList(
      [
        {
          name: "Debug",
          isa: "XCBuildConfiguration",
          buildSettings: {
            ...common,
            DEBUG_INFORMATION_FORMAT: "dwarf",
            SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"DEBUG $(inherited)"',
            SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
          },
        },
        {
          name: "Release",
          isa: "XCBuildConfiguration",
          buildSettings: {
            ...common,
            DEBUG_INFORMATION_FORMAT: '"dwarf-with-dsym"',
            SWIFT_COMPILATION_MODE: "wholemodule",
          },
        },
      ],
      "Release",
      `Build configuration list for PBXNativeTarget "${TARGET}"`,
    );

    const embedGroup = "Embed Foundation Extensions";
    const productFile = project.addProductFile(TARGET, {
      basename: `${TARGET}.appex`,
      group: embedGroup,
      explicitFileType: "wrapper.app-extension",
      settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
      includeInIndex: 0,
      path: `${TARGET}.appex`,
      sourceTree: "BUILT_PRODUCTS_DIR",
    });

    const targetUuid = project.generateUuid();
    const nativeTarget = {
      uuid: targetUuid,
      pbxNativeTarget: {
        isa: "PBXNativeTarget",
        name: TARGET,
        productName: TARGET,
        productReference: productFile.fileRef,
        productType: '"com.apple.product-type.app-extension"',
        buildConfigurationList: configurationList.uuid,
        buildPhases: [],
        buildRules: [],
        dependencies: [],
      },
    };
    project.addToPbxNativeTargetSection(nativeTarget);
    project.addToPbxProjectSection(nativeTarget);
    const projectSection = project.pbxProjectSection()[project.getFirstProject().uuid];
    projectSection.attributes.TargetAttributes ??= {};
    projectSection.attributes.TargetAttributes[targetUuid] = {
      CreatedOnToolsVersion: "16.0",
      LastSwiftMigration: 1600,
      ProvisioningStyle: "Automatic",
    };

    project.addBuildPhase(
      ["NotificationService.swift"],
      "PBXSourcesBuildPhase",
      "Sources",
      targetUuid,
      "app_extension",
      '""',
    );
    project.addBuildPhase(
      [],
      "PBXResourcesBuildPhase",
      "Resources",
      targetUuid,
      "app_extension",
      '""',
    );
    project.addBuildPhase(
      [],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      targetUuid,
      "app_extension",
      '""',
    );

    // Embed the extension in the app. Share the phase with other extensions when present.
    const appTargetUuid = project.getFirstTarget().uuid;
    let embedPhase = project.buildPhaseObject("PBXCopyFilesBuildPhase", embedGroup, appTargetUuid);
    if (!embedPhase) {
      project.addBuildPhase(
        [],
        "PBXCopyFilesBuildPhase",
        embedGroup,
        appTargetUuid,
        "app_extension",
        '""',
      );
      embedPhase = project.buildPhaseObject("PBXCopyFilesBuildPhase", embedGroup, appTargetUuid);
    }
    embedPhase.files.push({
      value: productFile.uuid,
      comment: `${productFile.basename} in ${productFile.group}`,
    });
    project.addToPbxBuildFileSection(productFile);
    project.addTargetDependency(appTargetUuid, [targetUuid]);

    const group = project.addPbxGroup(["NotificationService.swift"], TARGET, TARGET);
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);
    return modConfig;
  });
}

/** EAS needs every extension listed to make its signing credentials. */
function withEasExtension(config, bundleIdentifier) {
  const existing = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  if (existing.some((entry) => entry.targetName === TARGET)) return config;
  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        build: {
          ...config.extra?.eas?.build,
          experimental: {
            ...config.extra?.eas?.build?.experimental,
            ios: {
              ...config.extra?.eas?.build?.experimental?.ios,
              appExtensions: [
                ...existing,
                { targetName: TARGET, bundleIdentifier, entitlements: {} },
              ],
            },
          },
        },
      },
    },
  };
}

module.exports = function withNotificationServiceExtension(config) {
  const appBundleId = config.ios?.bundleIdentifier;
  if (!appBundleId) return config;
  const bundleIdentifier = `${appBundleId}.notification-service`;
  config = withEasExtension(config, bundleIdentifier);
  config = withExtensionFiles(config);
  return withExtensionTarget(config, bundleIdentifier);
};
module.exports.TARGET = TARGET;
