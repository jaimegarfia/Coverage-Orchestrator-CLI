import path from "node:path";
import fs from "fs-extra";
import { XMLParser } from "fast-xml-parser";

/**
 * Best-effort environment detection for Java projects.
 *
 * It detects:
 * - buildTool: Maven / Gradle
 * - Java version: from pom.xml properties or maven-compiler-plugin, or build.gradle sourceCompatibility
 * - Spring Boot version: from spring-boot-starter-parent or Gradle plugin
 *
 * Notes:
 * - This is intentionally heuristic and non-fatal: if something can't be detected, it returns null fields.
 */

function normalizeJavaVersion(v) {
  if (!v) return null;
  const s = String(v).trim();

  // Handle Maven properties like "8", "1.8", "17", "${java.version}"
  if (s.startsWith("${") && s.endsWith("}")) return null;

  // Common patterns
  if (s === "8") return "1.8";
  if (/^\d+$/.test(s)) return s; // 11, 17, 21 etc.
  if (/^1\.\d+$/.test(s)) return s; // 1.8

  // Gradle: JavaVersion.VERSION_1_8, VERSION_17
  const m = s.match(/VERSION_(\d+)(?:_(\d+))?/i);
  if (m) {
    const major = m[1];
    const minor = m[2];
    if (major === "1" && minor) return `1.${minor}`;
    if (major === "8") return "1.8";
    return major;
  }

  return s;
}

function normalizeSpringBootVersion(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.startsWith("${") && s.endsWith("}")) return null;
  // strip suffixes like -SNAPSHOT
  return s;
}

function parseXmlSafe(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });
  return parser.parse(xmlString);
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function getAttr(node, key) {
  return node?.[`@_${key}`];
}

async function detectAssertionLibFromPom(projectRoot) {
  const pomPath = path.resolve(projectRoot, "pom.xml");
  const exists = await fs.pathExists(pomPath);
  if (!exists) return null;

  const xml = await fs.readFile(pomPath, "utf8");

  // Fast heuristic: string contains (avoid full dependency graph resolution)
  const lower = xml.toLowerCase();
  if (lower.includes("assertj-core") || lower.includes("org.assertj")) {
    return "AssertJ";
  }
  if (lower.includes("hamcrest")) {
    return "Hamcrest";
  }
  return "JUnit 5 Assertions";
}

async function detectLombokFromPom(projectRoot) {
  const pomPath = path.resolve(projectRoot, "pom.xml");
  const exists = await fs.pathExists(pomPath);
  if (!exists) return false;

  const xml = await fs.readFile(pomPath, "utf8");
  const lower = xml.toLowerCase();

  return lower.includes("<artifactid>lombok</artifactid>") || lower.includes("org.projectlombok");
}

async function detectAssertionLibFromGradle(projectRoot) {
  const gradlePath = path.resolve(projectRoot, "build.gradle");
  const gradleKtsPath = path.resolve(projectRoot, "build.gradle.kts");

  const gradleExists = await fs.pathExists(gradlePath);
  const gradleKtsExists = await fs.pathExists(gradleKtsPath);
  if (!gradleExists && !gradleKtsExists) return null;

  const filePath = gradleExists ? gradlePath : gradleKtsPath;
  const text = await fs.readFile(filePath, "utf8");
  const lower = text.toLowerCase();

  if (lower.includes("assertj-core") || lower.includes("org.assertj")) {
    return "AssertJ";
  }
  if (lower.includes("hamcrest")) {
    return "Hamcrest";
  }
  return "JUnit 5 Assertions";
}

async function detectLombokFromGradle(projectRoot) {
  const gradlePath = path.resolve(projectRoot, "build.gradle");
  const gradleKtsPath = path.resolve(projectRoot, "build.gradle.kts");

  const gradleExists = await fs.pathExists(gradlePath);
  const gradleKtsExists = await fs.pathExists(gradleKtsPath);
  if (!gradleExists && !gradleKtsExists) return false;

  const filePath = gradleExists ? gradlePath : gradleKtsPath;
  const text = await fs.readFile(filePath, "utf8");
  const lower = text.toLowerCase();

  return lower.includes("lombok") || lower.includes("org.projectlombok");
}

/**
 * Find the project root based on a JaCoCo xml path.
 * It walks up directories until it finds a pom.xml or build.gradle(.kts).
 *
 * @param {string} xmlPath absolute path to jacoco.xml
 * @returns {Promise<string>} directory considered as project root (fallback: directory containing xmlPath)
 */
export async function findProjectRoot(xmlPath) {
  // Back-compat: previously this returned the *nearest* build file going upwards (module root).
  // It now returns the repo-level root (closest to filesystem root) among all build files found
  // when walking upwards from the jacoco.xml location.
  return findRepoRootFromXml(xmlPath);
}

/**
 * Find repo root from a JaCoCo xml path.
 * Strategy:
 * - Walk up from the directory containing jacoco.xml to filesystem root.
 * - Collect every directory that contains pom.xml or build.gradle(.kts).
 * - Return the "highest" one (the closest to filesystem root), i.e. the repo root / aggregator build.
 *
 * This enforces a single source of truth for .coverage-cache.json across commands.
 *
 * @param {string} xmlPath absolute path to jacoco.xml
 * @returns {Promise<string>} repo root (fallback: directory containing xmlPath)
 */
export async function findRepoRootFromXml(xmlPath) {
  const startDir = path.resolve(path.dirname(xmlPath));
  let current = startDir;

  let lastBuildRoot = null;

  // Walk up until filesystem root
  while (true) {
    const pom = path.join(current, "pom.xml");
    const gradle = path.join(current, "build.gradle");
    const gradleKts = path.join(current, "build.gradle.kts");

    if (
      (await fs.pathExists(pom)) ||
      (await fs.pathExists(gradle)) ||
      (await fs.pathExists(gradleKts))
    ) {
      // Keep updating; the last one found while walking up is the highest/root-most.
      lastBuildRoot = current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return lastBuildRoot ?? startDir;
}

function findInObject(obj, pathArr) {
  return pathArr.reduce((acc, k) => (acc ? acc[k] : undefined), obj);
}

async function detectFromPomXml(projectRoot) {
  const pomPath = path.resolve(projectRoot, "pom.xml");
  const exists = await fs.pathExists(pomPath);
  if (!exists) return null;

  const xml = await fs.readFile(pomPath, "utf8");
  const doc = parseXmlSafe(xml);
  const project = doc?.project;
  if (!project) return { buildTool: "Maven" };

  // spring-boot-starter-parent version
  let springBootVersion = null;
  const parent = project.parent;
  if (parent) {
    const groupId = parent.groupId;
    const artifactId = parent.artifactId;
    const version = parent.version;
    if (
      String(groupId ?? "").trim() === "org.springframework.boot" &&
      String(artifactId ?? "").trim() === "spring-boot-starter-parent"
    ) {
      springBootVersion = normalizeSpringBootVersion(version);
    }
  }

  // java.version property
  let javaVersion =
    normalizeJavaVersion(findInObject(project, ["properties", "java.version"])) ??
    normalizeJavaVersion(findInObject(project, ["properties", "maven.compiler.source"])) ??
    normalizeJavaVersion(findInObject(project, ["properties", "maven.compiler.release"])) ??
    null;

  // Try maven-compiler-plugin configuration
  // <build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><source>...</source></configuration>
  const plugins =
    asArray(findInObject(project, ["build", "plugins", "plugin"])) ??
    asArray(findInObject(project, ["build", "pluginManagement", "plugins", "plugin"]));

  for (const pl of plugins) {
    const artifactId = String(pl?.artifactId ?? "").trim();
    if (artifactId !== "maven-compiler-plugin") continue;

    const conf = pl?.configuration;
    const source = conf?.source;
    const release = conf?.release;
    javaVersion = javaVersion ?? normalizeJavaVersion(release) ?? normalizeJavaVersion(source);
    break;
  }

  return {
    buildTool: "Maven",
    javaVersion,
    springBootVersion,
  };
}

async function detectFromGradle(projectRoot) {
  const gradlePath = path.resolve(projectRoot, "build.gradle");
  const gradleKtsPath = path.resolve(projectRoot, "build.gradle.kts");

  const gradleExists = await fs.pathExists(gradlePath);
  const gradleKtsExists = await fs.pathExists(gradleKtsPath);

  if (!gradleExists && !gradleKtsExists) return null;

  const filePath = gradleExists ? gradlePath : gradleKtsPath;
  const text = await fs.readFile(filePath, "utf8");

  // sourceCompatibility = '1.8' / "1.8" / 1.8 / JavaVersion.VERSION_1_8
  let javaVersion = null;
  const sc =
    text.match(/sourceCompatibility\s*=\s*['"]([^'"]+)['"]/i) ??
    text.match(/sourceCompatibility\s*=\s*([^\s\r\n]+)/i);
  if (sc) javaVersion = normalizeJavaVersion(sc[1]);

  // Also look for targetCompatibility if source not found
  if (!javaVersion) {
    const tc =
      text.match(/targetCompatibility\s*=\s*['"]([^'"]+)['"]/i) ??
      text.match(/targetCompatibility\s*=\s*([^\s\r\n]+)/i);
    if (tc) javaVersion = normalizeJavaVersion(tc[1]);
  }

  // Spring Boot plugin version: id 'org.springframework.boot' version '2.7.5'
  let springBootVersion = null;
  const boot =
    text.match(/id\s+['"]org\.springframework\.boot['"]\s+version\s+['"]([^'"]+)['"]/i) ??
    text.match(/id\("org\.springframework\.boot"\)\s+version\s+"([^"]+)"/i);
  if (boot) springBootVersion = normalizeSpringBootVersion(boot[1]);

  return {
    buildTool: "Gradle",
    javaVersion,
    springBootVersion,
    buildFile: path.basename(filePath),
  };
}

/**
 * Detect environment from the project root.
 * @param {object} opts
 * @param {string} opts.projectRoot Directory to look for pom.xml / build.gradle
 * @returns {Promise<{language:string, version:string|null, framework:string|null, frameworkVersion:string|null, buildTool:string|null, detection?:object}>}
 */
export async function detectEnvironment({ projectRoot = process.cwd(), xmlPath = null } = {}) {
  const root = path.resolve(projectRoot);

  const [maven, gradle] = await Promise.all([
    detectFromPomXml(root),
    detectFromGradle(root),
  ]);

  const buildTool = maven?.buildTool ?? gradle?.buildTool ?? null;
  const javaVersion = maven?.javaVersion ?? gradle?.javaVersion ?? null;
  const springBootVersion = maven?.springBootVersion ?? gradle?.springBootVersion ?? null;

  const assertionLib =
    buildTool === "Maven"
      ? await detectAssertionLibFromPom(root)
      : buildTool === "Gradle"
        ? await detectAssertionLibFromGradle(root)
        : "JUnit 5 Assertions";

  const usesLombok =
    buildTool === "Maven"
      ? await detectLombokFromPom(root)
      : buildTool === "Gradle"
        ? await detectLombokFromGradle(root)
        : false;

  // Módulo (multi-módulo) best-effort:
  // - Maven: directorio que contiene el jacoco.xml relativo al repo root.
  // - Gradle: path ':sub:module' derivado del path relativo (con ':'), sin garantizar settings.gradle.
  const moduleName =
    xmlPath && root
      ? path.relative(root, path.resolve(path.dirname(xmlPath))).split(path.sep)[0] || "."
      : null;

  const gradleModulePath =
    buildTool === "Gradle" && moduleName && moduleName !== "." ? `:${moduleName}` : null;

  const env = {
    language: "Java",
    version: javaVersion,
    framework: springBootVersion ? "Spring Boot" : null,
    frameworkVersion: springBootVersion,
    buildTool,
    assertionLib: assertionLib ?? "JUnit 5 Assertions",
    usesLombok,
    moduleName: moduleName ?? null,
    gradleModulePath,
    detection: {
      projectRoot: root,
      fromPom: Boolean(maven),
      fromGradle: Boolean(gradle),
    },
  };

  return env;
}
