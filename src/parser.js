import fs from "fs-extra";
import { XMLParser } from "fast-xml-parser";

/**
 * JaCoCo XML parsing utilities.
 *
 * Expected jacoco.xml structure (simplified):
 * <report>
 *   <package name="com/foo">
 *     <class name="com/foo/MyClass" sourcefilename="MyClass.java">
 *       <method name="bar" desc="(I)Ljava/lang/String;" line="42">
 *         <counter type="INSTRUCTION" missed="10" covered="0"/>
 *         <counter type="LINE" missed="3" covered="0"/>
 *         <counter type="COMPLEXITY" missed="2" covered="0"/>
 *         ...
 *       </method>
 *       <counter type="LINE" missed="20" covered="5"/>
 *       <counter type="COMPLEXITY" missed="10" covered="2"/>
 *     </class>
 *   </package>
 * </report>
 *
 * This module normalizes the report into a JS object shape used by orchestrator.js.
 */

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getAttr(node, key) {
  // fast-xml-parser default attribute prefix is "@_"
  return node?.[`@_${key}`];
}

function getCounters(node) {
  const counters = new Map();
  for (const c of asArray(node?.counter)) {
    const type = getAttr(c, "type");
    if (!type) continue;
    counters.set(type, {
      missed: toInt(getAttr(c, "missed")),
      covered: toInt(getAttr(c, "covered")),
    });
  }
  return counters;
}

function pct(covered, missed) {
  const total = covered + missed;
  if (total <= 0) return 100;
  return (covered / total) * 100;
}

/**
 * Parse jacoco.xml and return a normalized report.
 *
 * @param {string} xmlPath Absolute or relative path to jacoco.xml
 * @returns {Promise<{
 *   packages: Array<{
 *     name: string,
 *     classes: Array<{
 *       name: string, // fully qualified class name with dots
 *       internalName: string, // original jacoco class name with slashes
 *       sourceFilename?: string,
 *       packageName?: string,
 *       counters: Record<string, {missed:number, covered:number}>,
 *       methods: Array<{
 *         name: string,
 *         desc?: string,
 *         line?: number,
 *         counters: Record<string, {missed:number, covered:number}>,
 *         lineCoveragePct: number
 *       }>,
 *       lineCoveragePct: number
 *     }>
 *   }>,
 *   totals: Record<string, {missed:number, covered:number}>
 * }>}
 */
export async function parseJacocoXml(xmlPath) {
  const xml = await fs.readFile(xmlPath, "utf8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    // Avoid parsing numeric strings automatically; we handle it ourselves.
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });

  const doc = parser.parse(xml);
  const report = doc?.report;
  if (!report) {
    throw new Error(`Invalid JaCoCo XML: missing <report> root (path: ${xmlPath})`);
  }

  const normalizedPackages = [];
  for (const p of asArray(report.package)) {
    const packageName = getAttr(p, "name") ?? "";
    const classes = [];

    for (const c of asArray(p?.class)) {
      const internalName = getAttr(c, "name") ?? "";
      const fqcn = internalName.replaceAll("/", ".");
      const sourceFilename = getAttr(c, "sourcefilename");

      const classCountersMap = getCounters(c);

      // Filtro de interfaces / clases sin bytecode instrumentable:
      // Si INSTRUCTION total es 0, JaCoCo suele estar reportando interfaces/holders sin instrucciones.
      // Ignoramos totalmente estas clases para evitar "DONE" falsos y ruido en el backlog.
      const instr = classCountersMap.get("INSTRUCTION") ?? { missed: 0, covered: 0 };
      const totalInstr = (instr.missed ?? 0) + (instr.covered ?? 0);
      if (totalInstr === 0) {
        continue;
      }

      const lineCounter = classCountersMap.get("LINE") ?? { missed: 0, covered: 0 };
      const classLineCoveragePct = pct(lineCounter.covered, lineCounter.missed);

      const methods = [];
      for (const m of asArray(c?.method)) {
        const methodCountersMap = getCounters(m);
        const mLine = methodCountersMap.get("LINE") ?? { missed: 0, covered: 0 };
        const methodLineCoveragePct = pct(mLine.covered, mLine.missed);

        methods.push({
          name: getAttr(m, "name") ?? "",
          desc: getAttr(m, "desc"),
          line: toInt(getAttr(m, "line"), undefined),
          counters: Object.fromEntries(methodCountersMap.entries()),
          lineCoveragePct: methodLineCoveragePct,
        });
      }

      classes.push({
        name: fqcn,
        internalName,
        sourceFilename,
        packageName,
        counters: Object.fromEntries(classCountersMap.entries()),
        methods,
        lineCoveragePct: classLineCoveragePct,
      });
    }

    normalizedPackages.push({
      name: packageName,
      classes,
    });
  }

  const totalsMap = getCounters(report);
  return {
    packages: normalizedPackages,
    totals: Object.fromEntries(totalsMap.entries()),
  };
}

/**
 * Convenience: flatten class list.
 * @param {Awaited<ReturnType<typeof parseJacocoXml>>} parsed
 */
export function flattenClasses(parsed) {
  const out = [];
  for (const p of parsed.packages) {
    for (const c of p.classes) out.push(c);
  }
  return out;
}

/**
 * Extract methods with 0% line coverage.
 * (If JaCoCo doesn't report LINE counter for a method, it's ignored.)
 */
export function getZeroCoverageMethods(clazz) {
  return (clazz?.methods ?? [])
    .filter((m) => {
      const line = m?.counters?.LINE;
      if (!line) return false;
      const total = (line.covered ?? 0) + (line.missed ?? 0);
      if (total <= 0) return false;
      return (line.covered ?? 0) === 0 && (line.missed ?? 0) > 0;
    })
    .filter((m) => {
      // Exclude synthetic/compiler-generated methods & constructors:
      // - Any method containing '$' (e.g., lambda$...)
      // - <init> (constructor) and <clinit> (static initializer)
      const name = m?.name ?? "";
      if (!name) return false;
      if (name.includes("$")) return false;
      if (name === "<init>" || name === "<clinit>") return false;
      return true;
    })
    .filter((m) => {
      // Lombok/boilerplate filter (best-effort).
      // These methods are commonly generated and rarely worth targeting explicitly if they have no coverage.
      // NOTE: We cannot reliably know if there is custom logic from JaCoCo alone, so we treat these as low ROI.
      const name = m?.name ?? "";
      const boilerplate = new Set(["equals", "hashCode", "toString", "canEqual"]);
      if (boilerplate.has(name)) return false;
      return true;
    });
}
