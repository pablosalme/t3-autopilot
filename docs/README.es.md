[English](../README.md) · **Español**

# t3-autopilot

[![CI](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml)

Elige el modelo de IA adecuado para cada tarea que encarga tu agente de [T3 Code](https://github.com/pingdotgg/t3code), para que no tengas que elegirlo tú.

## Qué es

En T3 Code, el agente con el que hablas puede encargar partes de un trabajo a agentes ayudantes, y cada ayudante puede funcionar con cualquiera de las suscripciones de IA que tengas conectadas: Claude, Codex, Cursor, Grok y otras. t3-autopilot es un pequeño complemento que le dice a tu agente qué modelo de los tuyos usar en cada una de esas tareas.

Piensa en quien reparte el trabajo en un taller: el encargo delicado va a la persona con más experiencia, barrer le toca al aprendiz y la revisión la hace alguien que no ha hecho la pieza. t3-autopilot hace eso mismo con tus modelos de IA:

| Tú pides | Sugiere | Por qué |
|---|---|---|
| Una funcionalidad nueva | Tu Claude Opus más reciente, pensando a fondo | Es un trabajo exigente |
| Revisar esa funcionalidad | Tu GPT más reciente, en Codex | La segunda opinión tiene que darla otro |
| Renombrar unos ficheros | Tu Claude Haiku más reciente, pensando poco | Basta con uno pequeño y rápido |

(Es lo que sale con las preferencias de serie si tienes conectados Claude y Codex y tu agente funciona con Claude. Puedes cambiarlas.)

Es un proyecto independiente; no forma parte de T3 Code.

## Para qué sirve

Por su cuenta, un agente tiende a:

- usar su propio modelo para todo, aunque a esa tarea le vaya mejor otra suscripción por la que también pagas;
- acordarse de nombres de modelos que se quedan viejos en cuanto sale una versión nueva;
- pedirle la revisión del código al mismo modelo que lo ha escrito.

Con t3-autopilot:

- **Cada tipo de tarea va a un modelo adecuado.** Trae una lista ya preparada para ocho tipos de tarea: programar, revisar, depurar, planificar, investigar, hacer cambios rápidos, diseñar y redactar.
- **Siempre usas la versión más reciente que tengas.** Las preferencias dicen «Claude Opus», sin número de versión, así que una versión nueva empieza a usarse en cuanto tu cuenta la ofrece.
- **Las revisiones son una segunda opinión de verdad,** porque las hace un proveedor distinto del de tu agente.
- **Una suscripción agotada no para el trabajo.** Si un ayudante no puede arrancar porque se ha llegado a un límite, tu agente pasa a la siguiente opción.
- **Sabes qué se ha elegido.** Tu agente te dice en una línea qué modelo ha escogido y por qué.

Solo aconseja. Nunca lanza agentes por su cuenta y nunca ve tus contraseñas ni los tokens de tus cuentas.

## Cómo funciona

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pablosalme/t3-autopilot/main/docs/assets/how-it-works-es-dark.gif">
  <img src="https://raw.githubusercontent.com/pablosalme/t3-autopilot/main/docs/assets/how-it-works-es-light.gif" alt="Animación en tres pasos. 1, Pregunta: tu agente, que funciona con Claude, tiene la tarea «Revisa el PR que mueve las comprobaciones de auth» y le pregunta a t3-autopilot qué modelo usar. 2, Decide: al revisar prefieres GPT, luego Gemini y luego Grok; de los modelos que tienes, Claude queda fuera porque es el de tu agente, y Cursor, sin cuota, pasa al final. 3, Responde: tres opciones, la mejor primero y cada una con su motivo: Codex con gpt-6.2-codex, Grok con grok-6 y Cursor con gemini-5.1-pro; el ayudante arranca con la primera. Los nombres de los modelos son inventados." width="880">
</picture>

1. **Tu agente pregunta.** Antes de encargar una tarea, le dice a t3-autopilot de qué tipo es y qué modelos tienes en T3 Code.
2. **t3-autopilot responde.** Consulta tus preferencias y devuelve hasta tres opciones, la mejor primero, cada una con su motivo.
3. **Tu agente usa la primera** y te dice en una línea qué modelo ha escogido y por qué. Si esa no puede arrancar, pasa a la siguiente.

Tu agente también puede apuntar cómo ha salido cada encargo (se aceptó tal cual, hubo que corregirlo o no sirvió), para que más adelante veas qué modelos te dan mejor resultado.

## Instalación

Necesitas:

- T3 Code, con la sesión iniciada en al menos un proveedor.
- [Node.js](https://nodejs.org) 22 o posterior. Para comprobarlo, ejecuta `node --version` en un terminal.

No hay nada que descargar a mano: `npx`, una herramienta que viene con Node.js, descarga t3-autopilot y lo ejecuta.

### Paso 1. Añádelo a tu agente

Solo lo necesita el agente con el que hablas (T3 Code lo llama *orquestador*); los ayudantes no. Copia la línea del agente que uses y pégala en un terminal:

**Claude Code**

```sh
claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
```

**Codex**

```sh
codex mcp add t3-autopilot -- npx -y t3-autopilot
```

**Grok CLI**

```sh
grok mcp add t3-autopilot -- npx -y t3-autopilot
```

**OpenCode**

```sh
opencode mcp add t3-autopilot --global -- npx -y t3-autopilot
```

Estas líneas registran t3-autopilot como *servidor MCP*, la forma estándar de darle una herramienta más a un agente de IA.

<details>
<summary>Otro agente, o uno que pida la configuración en JSON</summary>

Añade este bloque a su configuración de MCP:

```json
{
  "mcpServers": {
    "t3-autopilot": { "command": "npx", "args": ["-y", "t3-autopilot"] }
  }
}
```

</details>

### Paso 2. Dile a tu agente que lo use

Los agentes leen un fichero de reglas cada vez que arrancan: `CLAUDE.md` en Claude Code y `AGENTS.md` en casi todos los demás. t3-autopilot te muestra el párrafo que hay que añadirle:

```sh
npx -y t3-autopilot snippet
```

Copia lo que muestra y pégalo al final de tu fichero de reglas. O deja que lo haga el terminal (solo en macOS y Linux; en Windows, copia y pega, porque PowerShell puede guardar el texto añadido con una codificación distinta de la del resto del fichero). Para Claude Code:

```sh
npx -y t3-autopilot snippet >> ~/.claude/CLAUDE.md
```

Para Codex:

```sh
npx -y t3-autopilot snippet >> ~/.codex/AGENTS.md
```

Para Grok CLI:

```sh
npx -y t3-autopilot snippet >> ~/.grok/AGENTS.md
```

Para OpenCode:

```sh
npx -y t3-autopilot snippet >> ~/.config/opencode/AGENTS.md
```

No te saltes este paso. Sin él, tu agente tiene la herramienta pero no sabe cuándo usarla. El párrafo también le da permiso para cambiar de modelo, algo que T3 Code le dice que no haga por su cuenta.

<details>
<summary>Ver el párrafo que añade</summary>

Está en inglés porque son instrucciones para el agente:

```markdown
## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task in T3 Code following the t3-autopilot MCP server. Switching provider or model as recommended by `recommend_model` counts as asked for by the user.

1. For every child task, including the ones you would start with your native subagent tool, call `recommend_model` first with `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. Pass `capabilities` (the full output of `orchestrator_capabilities`) on the first call of the thread and again after an error or when providers change; the server keeps the last one, so other calls can omit it. Pass it whole, exactly as returned, never trimmed or summarised: a copy without each model's `options` loses the effort settings. If a call fails with "No capabilities yet", call `orchestrator_capabilities` and pass its full output again.
3. Use the first candidate. If it has `sameAsOrchestrator: true`, your native subagent tool is fine; otherwise call `delegate_task` with its `providerInstanceId`, `model` and `options` as `target`. If that child cannot start, or stops at once, because of a usage limit or its plan (for example "not included in your weekly usage"), call `mark_unavailable` with its `providerInstanceId`, its `model` (omit it if the whole provider is out), a short `reason` and `until` if you know when the limit resets, then use the next candidate.
4. Tell the user in one line which provider and model you picked, and why (the candidate's `reason`).
5. If `recommend_model` returns no candidate or fails, delegate inheriting your own provider and model, and say so.
6. If the result has `warnings` about omitted models, call `orchestrator_capabilities` with the `search` they suggest and pass that output to `recommend_model` as `capabilities` with `mergeCapabilities: true`.
7. If the user names a provider or model for a task, use theirs instead.
8. Right after delegating, call `log_delegation` with the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId`; keep the `delegationId`. After you review the child's result, call `log_outcome` with that `delegationId` and `outcome`: `success` (accepted as is), `corrected` (you had to fix or redo part of it) or `failure` (not usable; a child that could not start goes to `mark_unavailable` instead); add a short `note`.
```

</details>

### Paso 3. Reinicia tu agente

Reinicia tu agente en T3 Code para que cargue t3-autopilot y lea las reglas nuevas.

### Alternativa: instalar desde el código fuente

Si prefieres no usar `npx`, descarga el código y compílalo:

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci
```

Después sigue los mismos pasos, pero escribe `node /path/to/t3-autopilot/dist/cli.js` donde ponga `npx -y t3-autopilot` (cambia `/path/to` por la carpeta donde lo hayas descargado). Por ejemplo, para Claude Code:

```sh
claude mcp add --scope user t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js
```

Para actualizarlo más adelante, ejecuta `git pull` y luego otra vez `npm ci`.

## Comprueba que funciona

1. **El programa arranca.** Este comando muestra un número de versión:

   ```sh
   npx -y t3-autopilot --version
   ```

2. **Tu agente lo ve.** En Claude Code, `claude mcp list` muestra una línea como `t3-autopilot: ... ✔ Connected`. En Grok CLI, `grok mcp doctor` comprueba la conexión.
3. **Se usa.** En T3 Code, pídele a tu agente algo que tenga que encargar, por ejemplo: *«Delega en una tarea hija la revisión del README.»* Antes de empezar debería decirte en una línea qué proveedor y qué modelo ha escogido y por qué, algo como *«review #1: latest gpt on codex is gpt-6.2-codex, effort xhigh»* (el nombre del modelo es inventado).

Tras el primer encargo aparece una carpeta llamada `.t3-autopilot` en tu carpeta personal. Si no ocurre nada de esto, mira [las preguntas de más abajo](#preguntas).

## Ajústalo a tu gusto

t3-autopilot funciona sin configurar nada. Para cambiar sus preferencias, crea tu propio fichero de ajustes:

```sh
npx -y t3-autopilot init-policy
```

Este comando crea `policy.yaml` en la carpeta `.t3-autopilot` de tu carpeta personal. Es un fichero de texto con ejemplos ya preparados, todos desactivados con un `#` al principio de la línea. Ábrelo con cualquier editor de texto, quita el `#` de las líneas que quieras y guarda. Los cambios se aplican en la siguiente tarea; no hay que reiniciar nada.

Los cambios más habituales:

```yaml
# No usar nunca este proveedor (por ejemplo, uno que te reservas para ti):
excludeProviders: [cursor-work]

# Recibir dos opciones en vez de tres:
maxCandidates: 2
```

`cursor-work` es un ejemplo: usa el nombre del proveedor que muestra tu agente cuando explica su elección.

También puedes cambiar qué modelos se prefieren para cada tipo de tarea, o añadir una familia de modelos que no esté en la lista. Las dos cosas se explican en la [referencia](reference.md#the-policy) (en inglés).

Si te equivocas en el fichero, no se rompe nada: tu agente recibe un mensaje que dice qué hay que corregir y, mientras tanto, sigue con su propio modelo. Si un ajuste tiene un nombre que no conoce (una errata, por ejemplo), lo ignora y le dice a tu agente cuál es.

## Privacidad

Todo lo que guarda t3-autopilot está en una sola carpeta de tu ordenador: `.t3-autopilot`, dentro de tu carpeta personal.

| Fichero | Qué contiene |
|---|---|
| `policy.yaml` | Tus preferencias. Solo existe si lo has creado. |
| `log.jsonl` | Los encargos que tu agente ha apuntado: tipo de tarea, proveedor, modelo, ajustes usados, el identificador de la conversación del ayudante y cómo salió. Un resumen o una nota breve solo si tu agente los añade (200 caracteres como máximo). |
| `unavailable.json` | Proveedores o modelos que no se pueden usar durante un tiempo porque se llegó a un límite, con el motivo y hasta cuándo. |
| `capabilities-cache.json` | La última lista de proveedores y modelos que T3 Code le dio a tu agente, y si cada uno se puede usar. Sin contraseñas ni tokens. |

Lo que no hace nunca:

- **No se conecta a internet.** Nada sale de tu ordenador. (`npx` descarga el programa de npm; el programa en sí no se comunica con nadie.)
- **No lee contraseñas, claves de API, tokens ni cookies,** ni los ficheros de ajustes de T3 Code.
- **No guarda las descripciones de las tareas** que tu agente le envía al pedir una recomendación.
- **No lanza agentes ni cambia nada en T3 Code.** Solo recomienda; quien decide es tu agente.

## Desinstalación

1. Quítalo de tu agente:
   - Claude Code: `claude mcp remove t3-autopilot`
   - Grok CLI: `grok mcp remove t3-autopilot`
   - Codex: borra el bloque `t3-autopilot` de `~/.codex/config.toml`.
   - OpenCode: borra la entrada `t3-autopilot` de `~/.config/opencode/opencode.json`.
2. Borra de tu fichero de reglas (`CLAUDE.md` o `AGENTS.md`) el párrafo titulado «Model selection for delegated tasks (t3-autopilot)».
3. Borra la carpeta `.t3-autopilot` de tu carpeta personal, si no quieres conservar tus preferencias y el registro.

Nada más. Si lo instalaste desde el código fuente, borra también esa carpeta.

## Preguntas

**¿Cuesta dinero o consume mis suscripciones?**
No. Es gratuito y de código abierto, y nunca llama a un modelo de IA: solo responde a la pregunta de tu agente.

**¿Necesito T3 Code?**
Sí. Está pensado para la forma en que T3 Code reparte las tareas.

**¿Con qué proveedores funciona?**
Con todos los que ofrece T3 Code: Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, fx, Muse y agentes ACP. Vale cualquier combinación, también dos cuentas del mismo proveedor. En [providers.md](providers.md) (en inglés) están los detalles de cada uno.

**¿Sabe cuánto me queda de cada suscripción?**
No. T3 Code no comparte ese dato con los complementos, y t3-autopilot no va a leer los tokens de tus cuentas para averiguarlo. Lo que sí hace: cuando un ayudante no puede arrancar porque se ha llegado a un límite, tu agente lo apunta y ese proveedor pasa al final de la cola hasta que el límite se renueve (24 horas si no se sabe la fecha).

**Ha salido un modelo nuevo. ¿Tengo que actualizar algo?**
Normalmente no. Las preferencias nombran familias («Claude Opus», «GPT», «Gemini») y cada vez se escoge la versión más reciente que tengas. Solo una familia completamente nueva necesita una línea en tu fichero de ajustes.

**¿Mi agente sigue siempre la recomendación?**
Casi siempre, pero nada lo obliga: tu agente es un modelo de IA que sigue unas instrucciones escritas. Si tú nombras un modelo para una tarea, manda el tuyo.

**Parece que mi agente no lo usa. ¿Qué compruebo?**
Que el paso 1 ha funcionado (mira [Comprueba que funciona](#comprueba-que-funciona)), que el párrafo del paso 2 está en el fichero de reglas que lee tu agente, que has reiniciado el agente después y que `node --version` da 22 o más.

**¿Puedo ver cómo va?**
Sí. Pídele a tu agente las estadísticas de t3-autopilot: cuántas tareas han ido a cada modelo y cómo han salido.

**¿Son reales los nombres de modelos de los ejemplos?**
No. Los ejemplos usan versiones inventadas para que nadie las tome por afirmaciones sobre modelos reales.

**¿Dónde están los detalles técnicos?**
En la [referencia](reference.md) (en inglés): las herramientas, todos los ajustes, los formatos de los ficheros y cómo se reconoce a qué familia pertenece cada modelo.

## Más

- [Referencia](reference.md): todo lo técnico (en inglés).
- [Proveedores](providers.md): cómo se trata cada proveedor de T3 Code (en inglés).
- [Cómo contribuir](../CONTRIBUTING.md), [seguridad](../SECURITY.md) y [registro de cambios](../CHANGELOG.md).

## Licencia

[MIT](../LICENSE)
