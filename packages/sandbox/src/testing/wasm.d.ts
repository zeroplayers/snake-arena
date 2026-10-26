declare module "*.wasm" {
  const module: import("../sandbox.ts").WasmModule;
  export default module;
}
