const {
  withProjectBuildGradle,
  withSettingsGradle,
} = require('@expo/config-plugins');

const GEMMA_FLAG = 'ledgrGemmaEnabled';
const KOTLIN_VERSION = '2.4.0';
const KSP_VERSION = '2.3.10';

const DEFAULT_KOTLIN_CLASSPATH = "    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";
const GEMMA_KOTLIN_CLASSPATH = `    if (gradle.startParameter.projectProperties.get('${GEMMA_FLAG}') == 'true') {
      classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}')
    } else {
      classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
    }`;

const DEFAULT_EXPO_CATALOG = 'expoAutolinking.useExpoVersionCatalog()';
const GEMMA_EXPO_CATALOG = `expoAutolinking.useExpoVersionCatalog {
  if (providers.gradleProperty('${GEMMA_FLAG}').orNull == 'true') {
    version('kotlin', '${KOTLIN_VERSION}')
    version('ksp', '${KSP_VERSION}')
  }
}`;

function replaceRequired(contents, anchor, replacement, label) {
  if (contents.includes(replacement)) return contents;
  if (!contents.includes(anchor)) {
    throw new Error(`Unable to configure ${label}; the expected Expo Gradle anchor was not found.`);
  }
  return contents.replace(anchor, replacement);
}

function patchProjectBuildGradle(contents) {
  return replaceRequired(
    contents,
    DEFAULT_KOTLIN_CLASSPATH,
    GEMMA_KOTLIN_CLASSPATH,
    'the Gemma Kotlin compiler',
  );
}

function patchSettingsGradle(contents) {
  return replaceRequired(
    contents,
    DEFAULT_EXPO_CATALOG,
    GEMMA_EXPO_CATALOG,
    'the Gemma Expo version catalog',
  );
}

/**
 * Keeps the default/Needle Android build on Expo's supported Kotlin toolchain,
 * while allowing the downloadable Gemma product to opt in with:
 *   gradlew -PledgrGemmaEnabled=true ...
 *
 * LiteRT-LM 0.17.0 carries Kotlin 2.4 metadata, so both the root Kotlin plugin
 * classpath and Expo's version catalog must change together. KSP 2.3.10
 * is selected because Expo 54's lookup table predates Kotlin 2.4.
 */
function withGemmaAndroidToolchain(config) {
  config = withProjectBuildGradle(config, (mod) => {
    mod.modResults.contents = patchProjectBuildGradle(mod.modResults.contents);
    return mod;
  });

  return withSettingsGradle(config, (mod) => {
    mod.modResults.contents = patchSettingsGradle(mod.modResults.contents);
    return mod;
  });
}

module.exports = withGemmaAndroidToolchain;
module.exports.patchProjectBuildGradle = patchProjectBuildGradle;
module.exports.patchSettingsGradle = patchSettingsGradle;
