// Stands in for Node's "module" builtin in browser bundles: harfbuzzjs (an
// Emscripten build) imports it only when running under Node.
export const createRequire = undefined;
export default {};
