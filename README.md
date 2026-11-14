# SPHEREx Sky Timeline

Página web pública: escribes unas coordenadas del cielo y te muestra cómo cambia esa región con el tiempo,
con imágenes infrarrojas de la misión SPHEREx (NASA). Datos oficiales de NASA/IPAC IRSA.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La página (interfaz, línea del tiempo, modos Normal / Blink / Cambios). |
| `lib.js` | Lógica de datos: consulta a IRSA, lectura de FITS, alineación de imágenes. |
| `worker.js` | Proxy opcional (Cloudflare Workers) por si el navegador no puede llamar directo a IRSA. |
| `fetch_cutouts.py` | Script opcional para pre-descargar objetivos a la carpeta `data/`. |
| `data/index.json` | Lista de objetivos pre-descargados (vacía por defecto). |

## Cómo obtiene los datos oficiales (3 vías)

1. **En vivo (por defecto).** Cuando alguien escribe coordenadas, la página consulta el servicio TAP de IRSA,
   baja recortes pequeños de las imágenes de SPHEREx, los alinea y arma la línea del tiempo. No necesita servidor.
2. **En vivo con proxy.** Si en la página pública aparece el aviso de bloqueo CORS, publica `worker.js` en
   Cloudflare Workers (gratis), y pon su dirección en `CONFIG.PROXY` dentro de `index.html`, por ejemplo:
   `PROXY: "https://spherex-proxy.TU-USUARIO.workers.dev/?url="`
3. **Pre-descargado.** Con Python corres `fetch_cutouts.py` y subes la carpeta `data/`; aparecen como
   "Ejemplos pre-descargados" y funcionan aunque IRSA esté lento o caído (ideal para la demo).

## Publicar en GitHub Pages

Sube todo el contenido de esta carpeta a la raíz del repositorio. En Settings → Pages elige la rama `main`
y la carpeta `/ (root)`.

## Pre-descargar objetivos (opcional)

```
pip install -r requirements.txt
python fetch_cutouts.py --name "Nebulosa de Orion" --ra 83.8221 --dec -5.3911 --size 0.15 --max-images 40
```

Suelta la carpeta `data/` resultante en el repositorio.

## Notas técnicas

- La alineación usa la proyección TAN con la matriz CD/PC de cada recorte; ignora la distorsión fina del detector,
  que en campos pequeños es despreciable.
- Cada cuadro puede ser de otra banda de color: parte de lo que cambia es el color, no el objeto.
- La fecha se calcula suponiendo que `time_bounds_lower` está en MJD; verifícalo con un resultado real.

## Créditos

Datos: NASA SPHEREx, NASA/IPAC Infrared Science Archive (IRSA). Proyecto del NASA Space Apps Challenge 2026;
no es un producto oficial de la NASA.
