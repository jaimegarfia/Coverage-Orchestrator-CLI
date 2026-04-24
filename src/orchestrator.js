import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { flattenClasses, getZeroCoverageMethods } from "./parser.js";

const DEFAULT_CACHE_FILE = ".coverage-cache.json";

export function getCachePathForRoot(projectRoot, cacheFile = DEFAULT_CACHE_FILE) {
  return path.resolve(projectRoot, cacheFile);
}

/**
 * Intenta auto-detectar jacoco.xml en rutas comunes (Maven/Gradle)
 * @returns {Promise<string|null>} ruta al jacoco.xml o null si no se encuentra
 */
export async function autoDetectJacocoXml({
  cwd = process.cwd(),
  recursive = false,
  maxDepth = 4,
} = {}) {
  // Direct candidates (relative to cwd)
  const directCandidates = [
    "target/site/jacoco/jacoco.xml", // Maven default
    "build/reports/jacoco/test/jacocoTestReport.xml", // Gradle default
  ];

  for (const candidate of directCandidates) {
    const p = path.resolve(cwd, candidate);
    if (await fs.pathExists(p)) return p;
  }

  if (!recursive) return null;

  // Recursive search (best-effort) for monorepos / multi-microservice folders.
  // We limit depth to avoid scanning huge trees.
  async function walk(dir, depth) {
    if (depth > maxDepth) return null;

    // If this directory looks like a project root, check typical jacoco locations here too.
    for (const candidate of directCandidates) {
      const p = path.resolve(dir, candidate);
      if (await fs.pathExists(p)) return p;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (name === "node_modules" || name === ".git" || name === "target" || name === "build") {
        continue;
      }

      const found = await walk(path.join(dir, name), depth + 1);
      if (found) return found;
    }

    return null;
  }

  return walk(path.resolve(cwd), 0);
}

export function getCachePath(cacheFile = DEFAULT_CACHE_FILE) {
  return path.resolve(process.cwd(), cacheFile);
}

export async function loadCache(cacheFile = DEFAULT_CACHE_FILE, { projectRoot = process.cwd() } = {}) {
  const p = getCachePathForRoot(projectRoot, cacheFile);
  const exists = await fs.pathExists(p);
  if (!exists) {
    return {
      version: 1,
      generatedAt: null,
      xmlPath: null,
      env: null,
      items: [],
    };
  }
  return fs.readJson(p);
}

export async function saveCache(cache, cacheFile = DEFAULT_CACHE_FILE, { projectRoot = process.cwd() } = {}) {
  const p = getCachePathForRoot(projectRoot, cacheFile);
  await fs.writeJson(p, cache, { spaces: 2 });
  return p;
}

/**
 * Legacy hook kept for backward compatibility with the CLI option `--ignore`.
 * By default we no longer ignore classes by name (DTO/Entity/Configuration/etc.).
 */
export function shouldIgnoreClassByName(className, ignorePatterns) {
  const patterns = ignorePatterns?.length ? ignorePatterns : [];
  return patterns.some((p) => className.includes(p));
}

export function computePriorityScore({ missedLines, complexity }) {
  return missedLines * complexity;
}

/**
 * Build cache items from parsed JaCoCo report.
 * Filtering rules:
 * - Ignore classes with line coverage > 90%
 * - Ignore classes that contain DTO/Entity/Configuration by default
 */
export function buildCacheItems(
  parsed,
  {
    includePatterns = [],
    ignorePatterns = null,
    minCoverageToIgnorePct = 90,
    autoDoneThresholdPct = null,
  } = {},
) {
  const classes = flattenClasses(parsed);

  const items = [];
  for (const clazz of classes) {
    const line = clazz.counters?.LINE ?? { missed: 0, covered: 0 };
    const instr = clazz.counters?.INSTRUCTION ?? { missed: 0, covered: 0 };
    const complexity = clazz.counters?.COMPLEXITY ?? { missed: 0, covered: 0 };

    // Filtro adicional de clases vacías:
    // - Aunque el parser ya filtra INSTRUCTION total = 0, el cache existente puede contener items viejos.
    // - Evita inflar los totales de líneas con clases sin instrucciones (discrepancia con el HTML).
    const missedInstructions = instr.missed ?? 0;
    const coveredInstructions = instr.covered ?? 0;
    const totalInstr = missedInstructions + coveredInstructions;
    if (totalInstr === 0) continue;

    const missedLines = line.missed ?? 0;
    const coveredLines = line.covered ?? 0;

    const totalLines = missedLines + coveredLines;
    const coveragePct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 100;

    const className = clazz.name;

    // includePatterns: if provided, allow overriding ignore by forcing include match
    const forcedInclude =
      includePatterns.length > 0 && includePatterns.some((p) => className.includes(p));

    if (!forcedInclude) {
      if (coveragePct > minCoverageToIgnorePct) continue;
      // No default ignore-by-name anymore; only apply if user passed --ignore patterns explicitly
      if (shouldIgnoreClassByName(className, ignorePatterns)) continue;
    }

    const complexityTotal = (complexity.missed ?? 0) + (complexity.covered ?? 0);
    const priorityScore = computePriorityScore({
      missedLines,
      complexity: complexityTotal || 1,
    });

    const zeroMethods = getZeroCoverageMethods(clazz).map((m) => ({
      name: m.name,
      desc: m.desc,
      line: m.line,
    }));

    const threshold =
      typeof autoDoneThresholdPct === "number" && Number.isFinite(autoDoneThresholdPct)
        ? autoDoneThresholdPct
        : null;

    const isAutoDone = threshold !== null && coveragePct >= threshold;

    items.push({
      className,
      packageName: clazz.packageName ?? null,
      sourceFilename: clazz.sourceFilename ?? null,
      internalName: clazz.internalName ?? null,

      metrics: {
        missedLines,
        coveredLines,
        coveragePct,
        missedInstructions,
        coveredInstructions,
        instructionCoveragePct: totalInstr > 0 ? (coveredInstructions / totalInstr) * 100 : 100,
        complexityTotal,
      },

      priorityScore,

      methods: {
        zeroCoverage: zeroMethods,
      },

      // Persistencia / resiliencia:
      // - attempts: nº de iteraciones en las que esta clase fue "asignada" por next pero no mejoró según analyze
      // - status: TODO | DONE | SKIPPED (blacklist automática)
      attempts: 0,
      status: isAutoDone ? "DONE" : "TODO",
      autoVerified: isAutoDone ? true : false,
      updatedAt: new Date().toISOString(),
    });
  }

  // Highest priority first
  items.sort((a, b) => b.priorityScore - a.priorityScore);

  return items;
}

export function pickNextMission(cache) {
  // Resiliencia: si attempts ya superó el límite, tratamos el item como SKIPPED (aunque status no lo refleje)
  const next = (cache?.items ?? []).find(
    (i) =>
      i.status !== "DONE" &&
      i.status !== "SKIPPED" &&
      !((Number.isFinite(i.attempts) ? i.attempts : 0) >= 5),
  );
  return next ?? null;
}

export function markDone(cache, className) {
  const item = (cache?.items ?? []).find((i) => i.className === className);
  if (!item) return { updated: false, reason: "NOT_FOUND" };

  item.status = "DONE";
  item.updatedAt = new Date().toISOString();
  return { updated: true };
}

export function markSkipped(cache, className, { reason = "MAX_ATTEMPTS" } = {}) {
  const item = (cache?.items ?? []).find((i) => i.className === className);
  if (!item) return { updated: false, reason: "NOT_FOUND" };

  item.status = "SKIPPED";
  item.skipReason = reason;
  item.updatedAt = new Date().toISOString();
  return { updated: true };
}

/**
 * Render mission markdown.
 * Note: Java file paths are best-effort because jacoco.xml only contains package + sourcefilename.
 * We output conventional Maven/Gradle paths; user/agent can adjust based on repository layout.
 */
export function renderMissionMarkdown(
  item,
  {
    sourceRoot = "src/main/java",
    testRoot = "src/test/java",
    env = null,
    suggestedTestCommand = null,
  } = {},
) {
  const pkgPath = (item.packageName ?? "").replaceAll(".", "/");
  const javaFile = item.sourceFilename
    ? path.posix.join(sourceRoot, pkgPath, item.sourceFilename)
    : "(unknown - missing sourcefilename in jacoco.xml)";

  const testFile = item.sourceFilename
    ? (() => {
        // Deterministic test naming: <ClassName>Test.java (no replace)
        // Use posix parsing to keep '/' separators in output paths
        const parsed = path.posix.parse(item.sourceFilename);
        const testBasename = `${parsed.name}Test${parsed.ext || ".java"}`;
        return path.posix.join(testRoot, pkgPath, testBasename);
      })()
    : "(unknown - missing sourcefilename in jacoco.xml)";

  const methods0 = item.methods?.zeroCoverage ?? [];
  const methodsList =
    methods0.length > 0
      ? methods0.map((m) => `- \`${m.name}\`${m.line ? ` (line ${m.line})` : ""}`).join("\n")
      : "_No se detectaron métodos con 0% LINE coverage (JaCoCo puede agregar counters agregados)._";

  const javaVersionLabel = env?.version ?? "desconocida";
  const frameworkLabel = env?.framework
    ? `${env.framework}${env.frameworkVersion ? ` ${env.frameworkVersion}` : ""}`
    : "desconocido";
  const assertionLib = env?.assertionLib ?? "JUnit 5 Assertions";

  const prompt = [
    `Genera tests unitarios JUnit 5 para la clase \`${item.className}\``,
    `con foco en aumentar la cobertura de líneas y ramas.`,
    ``,
    `Contexto:`,
    `- Entorno: Java ${javaVersionLabel}${env?.buildTool ? ` (${env.buildTool})` : ""}. Framework: ${frameworkLabel}.`,
    `- No uses sintaxis de versiones superiores a Java ${javaVersionLabel}.`,
    `- Usa JUnit 5 y ${assertionLib} para las verificaciones.`,
    ``,
    `Requisitos:`,
    `- Usa Mockito para simular dependencias (repositorios, clients HTTP, etc.).`,
    `- Cubre especialmente los métodos con 0% de cobertura listados abajo.`,
    `- Incluye casos: happy path, validaciones/errores, y edge cases.`,
    `- Si hay lógica condicional, añade tests para ambas ramas.`,
    `- Evita tests frágiles: no asserts sobre logs ni detalles internos innecesarios.`,
  ].join("\n");

  const commandSection = suggestedTestCommand
    ? [
        `## Sugerencia de comando (test selectivo)`,
        "```bash",
        suggestedTestCommand,
        "```",
        "",
      ].join("\n")
    : "";

  return [
    `# Mission: Increase coverage for \`${item.className}\``,
    ``,
    `## ROI / Priority`,
    `- **PriorityScore**: ${item.priorityScore}`,
    `- **MissedLines**: ${item.metrics.missedLines}`,
    `- **Complexity**: ${item.metrics.complexityTotal}`,
    `- **Current Line Coverage**: ${item.metrics.coveragePct.toFixed(2)}%`,
    ``,
    commandSection,
    `## Target files`,
    `- **Java source**: \`${javaFile}\``,
    `- **Test file**: \`${testFile}\``,
    ``,
    `## Methods with 0% coverage (LINE)`,
    methodsList,
    ``,
    `## Suggested prompt for the AI agent`,
    "```text",
    prompt,
    "```",
    ``,
    `## Notes`,
    `- Ajusta rutas si tu proyecto usa otra estructura (multi-módulo, /app, etc.).`,
    `- Si el método requiere builders/fixtures, crea helpers para mantener tests legibles.`,
  ].join("\n");
}

export function logCacheSummary(cache) {
  const total = cache?.items?.length ?? 0;
  const done = (cache?.items ?? []).filter((i) => i.status === "DONE").length;
  const todo = total - done;

  console.log(chalk.cyan(`Cache items: ${total} (TODO: ${todo}, DONE: ${done})`));
}
