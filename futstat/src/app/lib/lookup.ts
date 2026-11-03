/**
 * Búsqueda segura en tablas de etiquetas indexadas con texto que viene de los datos.
 *
 * `tabla[clave]` sobre un objeto literal también encuentra lo heredado de Object.prototype: con claves como
 * "__proto__", "constructor" o "toString" devuelve un objeto o una función, y pintarlo hace caer React
 * (error #31) o muestra "function Object() { [native code] }". Aquí solo cuentan las claves PROPIAS de la tabla.
 */
const hasOwn = Object.prototype.hasOwnProperty;

export function lookup<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && hasOwn.call(table, key) ? table[key] : undefined;
}
