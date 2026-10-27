declare module "*.wasm" {
  const module: import("@zerosnake/sandbox").WasmModule;
  export default module;
}
