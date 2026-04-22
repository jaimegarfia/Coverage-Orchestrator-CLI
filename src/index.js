#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { parseJacocoXml } from "./parser.js";
import { detectEnvironment, findProjectRoot } from "./detector.js";
import {
  buildCacheItems,
  loadCache,
  logCacheSummary,
  markDone,
  pickNextMission,
  renderMissionMarkdown,
  saveCache,
} from "./orchestrator.js";

const program = new Command();

program
  .name("coverage-orchestrator")
  .description(
    "Coverage Orchestrator CLI - Prioritiza clases Java para aumentar cobertura con JaCoCo",
  )
  .version("1.0.0");

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
      const { autoDetectJacocoXml } = await import("./orchestrator.js");
      xmlPath = await autoDetectJacocoXml();

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

    // 1) Detectar entorno del proyecto real
    const env = await detectEnvironment({ projectRoot });

    // 2) Cargar cache previo del microservicio (si existe)
    const oldCache = await loadCache(undefined, { projectRoot });
    const oldItemsByClass = new Map(
      (oldCache.items ?? []).map((it) => [it.className, it]),
    );

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

    // 3) Fusionar con cache previo: si una clase estaba DONE, mantener DONE
    const mergedItems = newItemsRaw.map((newItem) => {
      const old = oldItemsByClass.get(newItem.className);
      if (old && old.status === "DONE") {
        return {
          ...newItem,
          status: "DONE",
          updatedAt: new Date().toISOString(),
        };
      }
      return newItem;
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
    // Cache is stored in the microservice project root.
    // If the user runs `next` from another folder, try to locate jacoco.xml first by auto-detection.
    const { autoDetectJacocoXml } = await import("./orchestrator.js");
    const xmlPath = await autoDetectJacocoXml();
    const projectRoot = xmlPath ? await findProjectRoot(xmlPath) : process.cwd();

    const cache = await loadCache(undefined, { projectRoot });
    const item = pickNextMission(cache);

    if (!item) {
      console.log(
        chalk.green("No hay misiones pendientes. (cache vacío o todo DONE)"),
      );
      return;
    }

    const md = renderMissionMarkdown(item, {
      sourceRoot: opts.sourceRoot,
      testRoot: opts.testRoot,
      env: cache.env ?? null,
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
    const { autoDetectJacocoXml } = await import("./orchestrator.js");
    const xmlPath = await autoDetectJacocoXml();
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
    const cache = await loadCache();
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

    const table = new Table({
      head: [
        chalk.white("Class"),
        chalk.white("Coverage %"),
        chalk.white("PriorityScore"),
        chalk.white("Status"),
      ],
    });

    for (const it of top5) {
      table.push([
        it.className,
        `${it.metrics.coveragePct.toFixed(2)}%`,
        it.priorityScore,
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
