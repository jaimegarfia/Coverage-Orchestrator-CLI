# Coverage Orchestrator CLI
CLI en Node.js para **orquestar la subida de cobertura** en microservicios Java a partir de un reporte **JaCoCo XML**. Analiza el reporte, calcula un **ROI de cobertura** por clase y genera “misiones” en Markdown para que un agente de IA cree tests unitarios de alto impacto.

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- Proyecto Java que genere `jacoco.xml` (Maven o Gradle)

---

## Instalación / Distribución

### Opción A (recomendada): usarlo sin instalar (npx)
Cuando publiques el paquete en npm, cualquier usuario podrá ejecutar:

```bash
npx coverage-orchestrator analyze --path <ruta_al_jacoco.xml>
npx coverage-orchestrator next
npx coverage-orchestrator mark-done <className>
```

### Opción B: instalación global

```bash
npm install -g coverage-orchestrator-cli
coverage-orchestrator --help
```

### Opción C: desarrollo local (este repo)

```bash
npm install
node src/index.js --help
```

Para simular instalación del binario desde el repo:

```bash
npm link
coverage-orchestrator --help
```

Para desinstalar el link:

```bash
npm unlink -g coverage-orchestrator-cli
```

---

## Dónde encontrar el `jacoco.xml`

### Maven (lo más común)
Tras ejecutar tests + report:

```bash
mvn test jacoco:report
```

Suele quedar en:

- `target/site/jacoco/jacoco.xml`

### Gradle
Normalmente:

- `build/reports/jacoco/test/jacocoTestReport.xml`

---

## Uso

### 1) Analizar el reporte y generar cache

El CLI **auto-detecta** el `jacoco.xml` en rutas comunes (Maven/Gradle):

```bash
coverage-orchestrator analyze
```

Si no lo encuentra automáticamente, especifica la ruta:

```bash
coverage-orchestrator analyze --path "C:\\path\\to\\jacoco.xml"
```

Esto genera un fichero local:

- `.coverage-cache.json`

Opciones:

- `--path <ruta>`: ruta al jacoco.xml (opcional, auto-detecta si no se especifica)
- `--minCoverageToIgnore <pct>`: ignora clases con cobertura de líneas > pct (default 90)
- `--ignore <pattern...>`: ignora clases cuyo nombre contenga alguno de esos substrings
- `--include <pattern...>`: fuerza incluir clases aunque coincidan con reglas de ignore

Ejemplo:

```bash
coverage-orchestrator analyze --minCoverageToIgnore 95
```

### 2) Pedir la siguiente misión

```bash
coverage-orchestrator next
```

`next` devuelve una misión en Markdown con:

- Ruta sugerida del Java a testear
- Ruta sugerida del test (o dónde crearlo)
- Lista de métodos con 0% cobertura (según JaCoCo)
- Prompt sugerido para que un agente de IA genere los tests

Opciones:

- `--sourceRoot <path>` (default: `src/main/java`)
- `--testRoot <path>` (default: `src/test/java`)

### 3) Marcar una clase como completada

```bash
coverage-orchestrator mark-done com.foo.BarService
```

---

## Cómo funciona (alto nivel)

1) **Parseo** del `jacoco.xml`
2) Por clase, calcula:

- `MissedLines` = counter `LINE.missed`
- `Complexity` = counter `COMPLEXITY.missed + COMPLEXITY.covered`
- `PriorityScore = MissedLines * Complexity`

3) Aplica filtros por defecto:

- ignora cobertura de líneas > 90%
- ignora clases con `DTO`, `Entity` o `Configuration` en el nombre

4) Ordena por `PriorityScore` y guarda en `.coverage-cache.json`.

---

## Limitaciones conocidas

- La ruta sugerida del test depende de `sourcefilename` del XML y puede necesitar ajustes.
- JaCoCo puede listar métodos sintéticos (por ejemplo `lambda$...`) en la lista de 0%.

---

## Roadmap

- Mejorar detección de rutas reales del repo (multi-módulo, prefijos de proyecto)
- Filtrado de métodos sintéticos (`lambda$`, `access$`, `<init>`, `<clinit>`)
- Enriquecer el “prompt” con dependencias reales (parseando imports / constructor injection)
- Modo `--format json` además de Markdown

---

## Publicación a npm

Para publicar este paquete a npm y hacerlo disponible públicamente, consulta la guía detallada en [PUBLISH.md](./PUBLISH.md).

**Resumen rápido:**

1. Inicia sesión en npm: `npm login`
2. Verifica el contenido: `npm pack --dry-run`
3. Publica: `npm publish`

Una vez publicado, cualquier usuario podrá ejecutar:

```bash
npx coverage-orchestrator-cli analyze
```

---

## Licencia

ISC
