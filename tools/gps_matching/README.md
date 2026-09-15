# Asistente de coordenadas GPS por ruta

Herramienta operativa para completar coordenadas GPS de clientes en
bloque, por ruta, en vez de uno por uno en el wizard "Buscar GPS por
nombre". **No es parte del addon `shalom_location_map`** y nunca se
despliega al servidor: opera contra la API externa estándar de Odoo
(XML-RPC/JSON-RPC), igual que cualquier integración de terceros, así
que el flujo de script+hash+permisos+restart de `CLAUDE.md` no aplica
acá.

## Qué hace y qué NO hace

- Busca en Google Places (Text Search) el nombre de cada cliente **sin
  coordenadas** de una ruta dada -- mismo motor que ya usa el wizard.
- Decide con reglas explícitas (`scoring.py`, no aprendizaje automático
  real) si algún candidato es lo bastante confiable como para escribirlo
  directo, si hay que dejarlo para revisión humana, o si no hay ninguna
  opción confiable. La confianza combina **tres señales**, ninguna decide
  sola:
  1. **Nombre**: qué tan parecido es el nombre guardado en Odoo al del
     candidato (incluye chequeo de tipo de negocio y de número de local).
  2. **Dirección**: cuánto de la dirección guardada en Odoo (aunque sea
     parcial, ej. "Colón") aparece en la dirección completa que trae
     Google (ej. "Colón, Sabanitas, Calle 20").
  3. **Distancia**: qué tan consistente es la ubicación del candidato
     con las demás ubicaciones YA CONFIRMADAS de la misma ruta.

  Si al cliente le falta alguna de estas señales (sin dirección cargada,
  ruta sin ninguna ubicación confirmada todavía), esa señal simplemente
  no participa del promedio -- no se inventa un valor ni penaliza.
- **Nunca toca un cliente que ya tenga coordenadas** -- si el usuario ya
  las cargó, se asume que ya las revisó y aprobó antes. Esta herramienta
  solo actúa sobre los que están vacíos.
- Escribe las de "alta confianza" **de una** (no pide aprobación previa)
  -- el checkpoint humano es posterior: revisar el reporte y corregir lo
  que haga falta (trivial: se puede borrar/cambiar cualquier coordenada
  después, con esta misma herramienta con `--solo-reportar` seguido del
  wizard, o directamente en Odoo).
- Los casos "dudosos" **no** se escriben solos -- quedan en el reporte
  con sus opciones para que el usuario elija a mano (en el wizard, por
  ejemplo).

Importante: **una sola opción de Google no es sinónimo de alta
confianza.** A veces Google devuelve un único resultado aunque ni el
nombre, ni la dirección, ni la distancia coincidan -- pasa pocas veces
pero pasa. Por eso una sola opción se evalúa exactamente igual que si
hubiera varias, nunca se acepta "porque no había otra".

## Variables de entorno requeridas

| Variable | Qué es | Dónde conseguirla |
|---|---|---|
| `ODOO_URL` | URL pública HTTPS de Odoo | El mismo dominio con el que se entra por navegador -- **no** la IP cruda de la VM |
| `ODOO_DB` | Nombre de la base | En producción: `shalom` |
| `ODOO_USERNAME` | Login del usuario Odoo | El mismo con el que se entra a la interfaz web |
| `ODOO_API_KEY` | Clave API del usuario | Ajustes → Usuarios y Compañías → Usuarios → [el usuario] → pestaña "Seguridad de la cuenta" → "Nueva clave API" -- **nunca la contraseña real** |
| `GOOGLE_PLACES_API_KEY` | Misma que ya usa el wizard en producción | Ya configurada en el servidor -- pedírsela a quien la tenga a mano |
| `ODOO_TRANSPORT` (opcional) | `xmlrpc` (default) o `jsonrpc` | Cambiar a `jsonrpc` solo si el entorno donde corre esto no puede llegar al endpoint XML-RPC directo |

Ninguna se hardcodea ni se commitea. Copiar `.env.example` a `.env` (ya
ignorado por git) y completarlo, o exportarlas directo en la terminal.

## Uso

```bash
pip install requests   # si no está ya instalado

export $(cat .env | xargs)   # o exportar las variables a mano

# primera vez con una ruta: solo mirar, sin escribir nada todavía
python -m tools.gps_matching.cli --ruta "Colón Norte" --solo-reportar

# una vez calibrado el criterio, correrla en serio (escribe las de alta confianza)
python -m tools.gps_matching.cli --ruta "Colón Norte"

# o por id, si el nombre es ambiguo
python -m tools.gps_matching.cli --ruta-id 42
```

## Flujo recomendado

1. Correr con `--solo-reportar` la primera vez en una ruta chica, para
   confirmar que el criterio (qué cae en alta confianza / dudoso / sin
   coincidencia) coincide con lo que el usuario elegiría a mano.
2. Correrla en serio (sin `--solo-reportar`) -- escribe las de alta
   confianza, imprime el reporte completo.
3. Revisar el reporte: los "dudosos" se resuelven a mano (wizard,
   viendo las opciones que ya vienen listadas con su score), los "sin
   coincidencia" quedan sin GPS a propósito.
4. Corregir cualquier cosa que se haya escrito mal es trivial -- borrar/
   cambiar la coordenada como siempre.
5. Repetir con la próxima ruta.

## Ajustar el criterio

Los umbrales y la lista de categorías de negocio están todos como
constantes al principio de `scoring.py`, pensados para tocarse ahí
directo si en la práctica el criterio queda muy laxo o muy estricto --
no hace falta entender el resto del archivo para ajustarlos.
