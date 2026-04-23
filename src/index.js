#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { parseJacocoXml } from "./parser.js";
import { detectEnvironment, findProjectRoot } from "./detector.js";
import {
  autoDetectJacocoXml,
  buildCacheItems,
  loadCache,
  logCacheSummary,
  markDone,
  pickNextMission,
  renderMissionMarkdown,
  saveCache,
} from "./orchestrator.js";

function buildSuggestedTestCommand({ env, item }) {
  if (!env?.buildTool || !item?.className) return null;

  const simpleName = String(item.className).split(".").pop();
  const testClass = `${simpleName}Test`;
  const module = env.moduleName && env.moduleName !== "." ? env.moduleName : null;

  if (env.buildTool === "Maven") {
    // -pl only if we can infer module
    return module
      ? `mvn test -pl ${module} -Dtest=${testClass}`
      : `mvn test -Dtest=${testClass}`;
  }

  if (env.buildTool === "Gradle") {
    const gradleModule = env.gradleModulePath ?? (module ? `:${module}` : null);
    return gradleModule
      ? `./gradlew ${gradleModule}:test --tests ${testClass}`
      : `./gradlew test --tests ${testClass}`;
  }

  return null;
}

const program = new Command();

program
  .name("coverage-orchestrator")
  .description(
    [
      "Coverage Orchestrator CLI",
      "",
      "Convierte un reporte JaCoCo XML (jacoco.xml) en un backlog priorizado de 'misiones' en Markdown",
      "para aumentar cobertura de tests unitarios en microservicios Java.",
      "",
      "Flujo recomendado:",
      "  1) Genera jacoco.xml (Maven: mvn test jacoco:report | Gradle: ./gradlew test jacocoTestReport)",
      "  2) coverage-orchestrator analyze --path <ruta_al_xml>   (o sin --path si se auto-detecta)",
      "  3) coverage-orchestrator next                           (imprime una misión en Markdown)",
      "  4) Implementa tests -> vuelve a generar jacoco.xml -> repite",
      "",
      "Conceptos:",
      "  - PriorityScore = MissedLines * Complexity (ROI por clase)",
      "  - Auto-DONE: si coveragePct >= 60% la clase se marca DONE automáticamente al analizar",
      "  - Cache por microservicio: se guarda en <projectRoot>/.coverage-cache.json",
      "",
      "Ejemplos rápidos:",
      "  coverage-orchestrator analyze --path target/site/jacoco/jacoco.xml",
      "  coverage-orchestrator next",
      "  coverage-orchestrator summary",
      "",
      "Ayuda por comando:",
      "  coverage-orchestrator analyze --help",
      "  coverage-orchestrator next --help",
      "  coverage-orchestrator summary --help",
    ].join("\n"),
  )
  .version("1.2.0")
  .addHelpText(
    "after",
    [
      "",
      "Notas:",
      "  - Por defecto se ignoran clases con cobertura de líneas > 90% (configurable con --minCoverageToIgnore).",
      "  - No se ignora ninguna clase por nombre salvo que uses --ignore explícitamente.",
      "  - 'mark-done' existe por compatibilidad, pero el flujo recomendado es: tests -> analyze -> next.",
      "",
      "Repositorio:",
      "  https://github.com/jaimegarfia/Coverage-Orchestrator-CLI",
      "",
    ].join("\n"),
  );

program
  .command("analyze")
  .description("Escanea jacoco.xml y guarda el estado local en .coverage-cache.json")
  .option("--path <path>", "Ruta al archivo jacoco.xml (auto-detecta si no se especifica)")
  .option(
    "--include <pattern...>",
    "Incluye clases aunque coincidan con ignore rules (substrings)",
  )
  .option("--ignore <pattern...>", "Ignora clases por nombre (substrings).")
  .option(
    "--minCoverageToIgnore <pct>",
    "Ignora clases con cobertura de líneas > pct (default: 90)",
    "90",
  )
  .action(async (opts) => {
    let xmlPath = opts.path;

    // Auto-detect jacoco.xml if --path not provided
    if (!xmlPath) {
      // Primero intentamos en el cwd actual; si no, hacemos búsqueda recursiva (útil en monorepos).
      xmlPath =
        (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
        (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));

      if (!xmlPath) {
        console.log(chalk.red("No se encontró jacoco.xml automáticamente."));
        console.log(chalk.yellow("Rutas buscadas:"));
        console.log("  - target/site/jacoco/jacoco.xml (Maven)");
        console.log("  - build/reports/jacoco/test/jacocoTestReport.xml (Gradle)");
        console.log("");
        console.log(chalk.cyan("Por favor, especifica la ruta manualmente:"));
        console.log(
          chalk.white(
            "  coverage-orchestrator analyze --path <ruta_al_jacoco.xml>",
          ),
        );
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`✓ JaCoCo XML auto-detectado: ${xmlPath}`));
    }

    const minCoverageToIgnorePct = Number.parseFloat(opts.minCoverageToIgnore);
    const includePatterns = opts.include ?? [];
    const ignorePatterns = opts.ignore ?? null;

    // 0) Detectar projectRoot basándonos en la ubicación del jacoco.xml (best-effort)
    const projectRoot = await findProjectRoot(xmlPath);

    // 1) Detectar entorno del proyecto real (incluyendo nombre de módulo best-effort)
    const env = await detectEnvironment({ projectRoot, xmlPath });

    // 2) Cargar cache previo del microservicio (si existe)
    const oldCache = await loadCache(undefined, { projectRoot });
    const oldItemsByClass = new Map(
      (oldCache.items ?? []).map((it) => [it.className, it]),
    );
    const oldTopCandidateClassName = pickNextMission(oldCache)?.className ?? null;

    console.log(chalk.cyan(`Parsing JaCoCo report: ${xmlPath}`));
    const parsed = await parseJacocoXml(xmlPath);

    // 2) Construir nuevos items (status TODO por defecto)
    // Auto-DONE threshold: si una clase llega a >= 60% coverage, se considera terminada
    const COVERAGE_THRESHOLD = 60;

    const newItemsRaw = buildCacheItems(parsed, {
      includePatterns,
      ignorePatterns,
      minCoverageToIgnorePct: Number.isFinite(minCoverageToIgnorePct)
        ? minCoverageToIgnorePct
        : 90,
      autoDoneThresholdPct: COVERAGE_THRESHOLD,
    });

    // 3) Fusionar con cache previo
    //
    // Fuente de verdad: JaCoCo XML.
    // - El status base se calcula desde el XML (Auto-DONE si coveragePct >= threshold).
    // - Nunca mantenemos DONE "manual" si el XML actual dice que la cobertura no cumple el umbral.
    //   (Ej: coverage 0% => siempre TODO).
    //
    // Lo único que preservamos del cache anterior es el "marcado manual" cuando el XML lo permite,
    // para no perder el trabajo del usuario en clases que sí superan el umbral.
    const mergedItems = newItemsRaw.map((newItem) => {
      const old = oldItemsByClass.get(newItem.className);
      if (!old) return newItem;

      const threshold = COVERAGE_THRESHOLD;
      const coveragePct = newItem.metrics?.coveragePct ?? 0;

      // attempts: preservar contador entre análisis
      const prevAttempts = Number.isFinite(old.attempts) ? old.attempts : 0;

      // Si el XML no cumple threshold => jamás DONE, aunque estuviera DONE antes.
      // Además, si esta clase fue la última recomendada (top candidate) y sigue sin cumplir,
      // incrementamos attempts.
      if (!(coveragePct >= threshold)) {
        const isSameAsOldTop = oldTopCandidateClassName === newItem.className;
        const attempts = isSameAsOldTop ? prevAttempts + 1 : prevAttempts;

        // Blacklist automática a partir de 3 intentos
        if (attempts >= 3) {
          return {
            ...newItem,
            attempts,
            status: "SKIPPED",
            skipReason: "MAX_ATTEMPTS",
            autoVerified: false,
            updatedAt: new Date().toISOString(),
          };
        }

        return {
          ...newItem,
          attempts,
          status: "TODO",
          autoVerified: false,
          updatedAt: new Date().toISOString(),
        };
      }

      // Si el XML sí cumple threshold, se respeta DONE si estaba previamente DONE (manual)
      if (old.status === "DONE") {
        return {
          ...newItem,
          attempts: prevAttempts,
          status: "DONE",
          autoVerified: newItem.autoVerified ?? false,
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        ...newItem,
        attempts: prevAttempts,
      };
    });

    const cache = {
      version: oldCache.version ?? 1,
      generatedAt: new Date().toISOString(),
      xmlPath,
      env,
      items: mergedItems,
    };

    const cachePath = await saveCache(cache, undefined, { projectRoot });
    console.log(chalk.green(`Cache saved: ${cachePath}`));
    console.log(chalk.gray(`Project root: ${projectRoot}`));
    logCacheSummary(cache);
  });

program
  .command("next")
  .description("Devuelve la siguiente misión priorizada en Markdown")
  .option("--sourceRoot <path>", "Root de fuentes Java", "src/main/java")
  .option("--testRoot <path>", "Root de tests Java", "src/test/java")
  .action(async (opts) => {
    // El cache se guarda en el projectRoot del microservicio (mismo criterio que analyze).
    // Si ejecutas `next` desde otra carpeta, auto-detectamos jacoco.xml para inferir el projectRoot.
    const xmlPath =
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));
    const projectRoot = xmlPath ? await findProjectRoot(xmlPath) : process.cwd();

    const cache = await loadCache(undefined, { projectRoot });
    const item = pickNextMission(cache);

    if (!item) {
      console.log(
        chalk.green("No hay misiones pendientes. (cache vacío o todo DONE)"),
      );
      return;
    }

    const suggestedTestCommand = buildSuggestedTestCommand({
      env: cache.env ?? null,
      item,
    });

    const md = renderMissionMarkdown(item, {
      sourceRoot: opts.sourceRoot,
      testRoot: opts.testRoot,
      env: cache.env ?? null,
      suggestedTestCommand,
    });

    console.log(md);
  });

program
  .command("mark-done")
  .description("Marca una clase como DONE en el cache local")
  .argument("<className>", "Nombre fully-qualified de la clase (e.g. com.foo.BarService)")
  .action(async (className) => {
    // mark-done kept for backwards compatibility, but the intended workflow is now:
    // write tests -> run tests -> analyze -> next
    //
    // IMPORTANTE: el cache está asociado al microservicio (projectRoot). Por eso resolvemos el
    // projectRoot del mismo modo que `analyze`, a partir del jacoco.xml auto-detectado.
    const xmlPath =
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));
    const projectRoot = xmlPath ? await findProjectRoot(xmlPath) : process.cwd();

    const cache = await loadCache(undefined, { projectRoot });
    const res = markDone(cache, className);

    if (!res.updated) {
      console.log(
        chalk.red(
          `No se encontró la clase en el cache: ${className} (ejecuta analyze primero)`,
        ),
      );
      process.exitCode = 2;
      return;
    }

    const cachePath = await saveCache(cache, undefined, { projectRoot });
    console.log(chalk.green(`DONE: ${className}`));
    console.log(chalk.cyan(`Cache updated: ${cachePath}`));
    logCacheSummary(cache);
  });

program
  .command("summary")
  .description("Muestra un resumen global de cobertura basado en .coverage-cache.json")
  .option("--json", "Devuelve el resumen en formato JSON")
  .action(async (opts) => {
    // El resumen debe apuntar al mismo cache que analyze/next/mark-done.
    // Si se ejecuta desde otra carpeta, intentamos inferir el microservicio por auto-detección del jacoco.xml.
    const xmlPath =
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: false })) ??
      (await autoDetectJacocoXml({ cwd: process.cwd(), recursive: true, maxDepth: 4 }));
    const projectRoot = xmlPath ? await findProjectRoot(xmlPath) : process.cwd();
    const cache = await loadCache(undefined, { projectRoot });
    const items = cache.items ?? [];

    if (items.length === 0) {
      console.log(
        chalk.yellow(
          "No hay datos en el cache. Ejecuta primero: coverage-orchestrator analyze",
        ),
      );
      return;
    }

    // 1) Agregados globales (sumando todas las clases del cache)
    let totalMissed = 0;
    let totalCovered = 0;

    for (const it of items) {
      totalMissed += it.metrics?.missedLines ?? 0;
      totalCovered += it.metrics?.coveredLines ?? 0;
    }

    const totalLines = totalMissed + totalCovered;
    const globalCoveragePct = totalLines > 0 ? (totalCovered / totalLines) * 100 : 0;

    // Gap respecto a target 60%
    const targetPct = 60;
    const gapPct = targetPct - globalCoveragePct;

    // 2) Top 5 por priorityScore
    const sortedByPriority = [...items].sort(
      (a, b) => b.priorityScore - a.priorityScore,
    );
    const top5 = sortedByPriority.slice(0, 5);

    // 3) Siguiente recomendación (primera clase TODO) sin modificar el cache
    const next = pickNextMission(cache);

    const data = {
      total: {
        missedLines: totalMissed,
        coveredLines: totalCovered,
        totalLines,
        coveragePct: Number(globalCoveragePct.toFixed(2)),
        targetPct,
        gapPct: Number(gapPct.toFixed(2)),
      },
      topByPriority: top5.map((it) => ({
        className: it.className,
        coveragePct: Number(it.metrics.coveragePct.toFixed(2)),
        priorityScore: it.priorityScore,
        status: it.status,
      })),
      nextRecommendation: next
        ? {
            className: next.className,
            coveragePct: Number(next.metrics.coveragePct.toFixed(2)),
            priorityScore: next.priorityScore,
            status: next.status,
          }
        : null,
      cacheMeta: {
        generatedAt: cache.generatedAt,
        xmlPath: cache.xmlPath,
        items: items.length,
      },
    };

    // Modo JSON
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Modo humano con tabla
    console.log(
      chalk.cyan("== Resumen global de cobertura (desde .coverage-cache.json) =="),
    );
    console.log(
      `Líneas totales: ${totalLines}  |  Covered: ${totalCovered}  |  Missed: ${totalMissed}`,
    );
    console.log(
      `Coverage actual: ${globalCoveragePct.toFixed(
        2,
      )}%  |  Target: ${targetPct}%  |  Gap: ${gapPct.toFixed(2)}%`,
    );
    console.log("");

    // Nota: en algunas terminales (especialmente integradas) los caracteres de caja pueden renderizar raro.
    // Forzamos el estilo ASCII para evitar cortes y “saltos” de línea.
    const table = new Table({
      chars: {
        top: "-",
        "top-mid": "+",
        "top-left": "+",
        "top-right": "+",
        bottom: "-",
        "bottom-mid": "+",
        "bottom-left": "+",
        "bottom-right": "+",
        left: "|",
        "left-mid": "+",
        mid: "-",
        "mid-mid": "+",
        right: "|",
        "right-mid": "+",
        middle: "|",
      },
      head: [
        chalk.white("Clase"),
        chalk.white("Cobertura %"),
        chalk.white("PriorityScore"),
        chalk.white("Status"),
      ],
      wordWrap: true,
      wrapOnWordBoundary: false,
    });

    for (const it of top5) {
      table.push([
        it.className,
        `${it.metrics.coveragePct.toFixed(2)}%`,
        String(it.priorityScore),
        it.status,
      ]);
    }

    console.log(chalk.cyan("Top 5 clases por PriorityScore:"));
    console.log(table.toString());
    console.log("");

    if (next) {
      console.log(
        chalk.green("Siguiente recomendación (sin modificar el cache):"),
      );
      console.log(
        `- Clase: ${next.className} | Coverage: ${next.metrics.coveragePct.toFixed(
          2,
        )}% | PriorityScore: ${next.priorityScore} | Status: ${next.status}`,
      );
    } else {
      console.log(
        chalk.green(
          "No hay siguiente recomendación: todas las clases están DONE o el cache está vacío.",
        ),
      );
    }
  });

program.parseAsync(process.argv);
