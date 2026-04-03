declare module "*.wasm" {
    const content: WebAssembly.Module | BufferSource | string;
    export default content;
}
