/* ============ cloud-config.js — dónde está el servidor del juego ============
 * La API (api/v1.js) se publica en Vercel junto con el juego, así que basta
 * con la ruta '/api/v1'. Si el juego se publica en otra web (p. ej. GitHub
 * Pages) y la API en Vercel, pon aquí la dirección completa:
 *   G.CLOUD_API = 'https://tu-proyecto.vercel.app/api/v1';
 * y en Vercel la variable ALLOWED_ORIGINS con la dirección de esa web.
 * Pasos completos en docs/VERCEL.md.
 *
 * Si se pone a null, el juego funciona en modo local (sólo en el navegador).
 * Si el servidor no responde, también (y lo dice en la pantalla de inicio).
 */
G.CLOUD_API = '/api/v1';
