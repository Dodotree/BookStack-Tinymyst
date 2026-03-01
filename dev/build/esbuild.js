#!/usr/bin/env node

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

// Check if we're building for production
// (Set via passing `production` as first argument)
const isProd = process.argv[2] === "production";

// Gather our input files
const entryPoints = {
    app: path.join(__dirname, "../../resources/js/app.ts"),
    code: path.join(__dirname, "../../resources/js/code/index.mjs"),
    "legacy-modes": path.join(
        __dirname,
        "../../resources/js/code/legacy-modes.mjs"
    ),
    markdown: path.join(__dirname, "../../resources/js/markdown/index.mts"),
    wysiwyg: path.join(__dirname, "../../resources/js/wysiwyg/index.ts"),
    tinymist: path.join(__dirname, "../../resources/js/tinymist-bookstack.ts"),
};

// Locate our output directory
const outdir = path.join(__dirname, "../../public/dist");

const wasmPlugin = {
    name: "wasm",
    setup(build) {
        build.onResolve({filter: /\.wasm$/}, args => {
            // If it's a node_module import, resolve from node_modules
            if (args.path.startsWith('@') || args.path.startsWith('typst')) {
                return {
                    path: require.resolve(args.path),
                    namespace: "wasm-binary",
                };
            }

            // Otherwise resolve relative to importing file
            return {
                path: path.resolve(args.resolveDir, args.path),
                namespace: "wasm-binary",
            };
        });

        build.onLoad({filter: /.*/, namespace: "wasm-binary"}, async args => {
            const wasmPath = args.path;
            const wasmBinary = await fs.promises.readFile(wasmPath);
            const base64 = wasmBinary.toString("base64");

            return {
                contents: `
                    const wasmBase64 = "${base64}";
                    const wasmBinary = Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0));
                    export default wasmBinary;
                `,
                loader: "js",
            };
        });
    },
};

// Build via esbuild
esbuild
    .build({
        bundle: true,
        metafile: true,
        entryPoints,
        outdir,
        sourcemap: true,
        target: "es2021",
        mainFields: ["module", "main"],
        format: "esm",
        minify: isProd,
        logLevel: "info",
        plugins: [wasmPlugin],
        loader: {
            ".svg": "text",
        },
        absWorkingDir: path.join(__dirname, "../.."),
        alias: {
            "@icons": "./resources/icons",
            lexical: "./resources/js/wysiwyg/lexical/core",
            "@lexical": "./resources/js/wysiwyg/lexical",
        },
        banner: {
            js: '// See the "/licenses" URI for full package license details',
            css: '/* See the "/licenses" URI for full package license details */',
        },
    })
    .then(result => {
        fs.writeFileSync("esbuild-meta.json", JSON.stringify(result.metafile));
    })
    .catch(() => process.exit(1));
