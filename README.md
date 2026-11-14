# SPHEREx Sky Timeline

Herramienta web para ver cómo cambia el cielo con el tiempo usando imágenes de la misión SPHEREx (NASA).

## Cómo correrlo

1. Instalar dependencias: `pip install -r requirements.txt`
2. Descargar un objetivo (la consulta a IRSA tarda ~40 s):
   `python fetch_cutouts.py --name "Ejemplo IRSA" --ra 305.59875 --dec 41.14889 --size 0.15 --max-images 60`
3. Servir la carpeta: `python -m http.server 8000` y abrir http://localhost:8000
   (no abrir index.html con doble clic: el navegador bloquea la lectura de píxeles).

Sin datos descargados, el visor arranca con una **demo simulada** (se marca con la etiqueta "datos simulados").

## Estructura

- `fetch_cutouts.py`: consulta TAP de IRSA, descarga recortes, los reproyecta a una cuadrícula común (norte arriba) y escribe `data/<objetivo>/manifest.json` + PNG.
- `index.html`: visor con deslizador de tiempo, modo Blink (alterna dos fechas) y modo Cambios (resta la mediana de todos los cuadros).

## Pendientes / ideas

- Verificar con un resultado real que `time_bounds_lower` está en MJD (el script lo asume).
- Para objetos móviles (cometas, asteroides): pedir sus efemérides a JPL Horizons y mover la posición central en cada cuadro.
- Agrupar cuadros por banda de longitud de onda para comparar solo imágenes del mismo color.
- Publicar en GitHub Pages con los objetivos ya descargados (subir la carpeta `data/`).
- Ruta de datos alterna en la nube: bucket público `nasa-irsa-spherex` en AWS.

## Créditos

Datos: NASA SPHEREx, NASA/IPAC Infrared Science Archive (IRSA).
