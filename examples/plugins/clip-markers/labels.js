export function markerName(prefix, index, name) {
  return `${prefix} ${index + 1}: ${name}`.slice(0, 200);
}
