#!/usr/bin/env node

import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";
import * as process from "node:process";
import {createRequire} from "node:module";

// Check if we're building for production
// (Set via passing `production` as first argument)
const mode = process.argv[2];
const isProd = mode === "production";
const __dirname = import.meta.dirname;
const require = createRequire(import.meta.url);

// Gather our input files
const entryPoints = {
    app: path.join(__dirname, "../../resources/js/app.ts"),
    code: path.join(__dirname, "../../resources/js/code/index.mjs"),
    "legacy-modes": path.join(
        __dirname,
        "../../resources/js/code/legacy-modes.mjs",
    ),
    markdown: path.join(__dirname, "../../resources/js/markdown/index.mts"),
    wysiwyg: path.join(__dirname, "../../resources/js/wysiwyg/index.ts"),
};

const tinymistEntryPoints = {
    tinymist: path.join(
        __dirname,
        "../../themes/tinymist/resources/js/tinymist-bookstack.ts",
    ),
    "tinymist-convert": path.join(
        __dirname,
        "../../themes/tinymist/resources/js/tinymist-convert.ts",
    ),
};

// Watch styles so we can reload on change
if (mode === "watch") {
    entryPoints["styles-dummy"] = path.join(
        __dirname,
        "../../public/dist/styles.css",
    );
}

// Locate our output directory
const outdir = path.join(__dirname, '../../public/dist');
const tinymistOutDir = path.join(__dirname, "../../themes/tinymist/public");

const wasmPlugin = {
    name: "wasm",
    setup(build) {
        build.onResolve({filter: /\.wasm$/}, args => {
            // If it's a node_module import, resolve from node_modules
            if (args.path.startsWith("@") || args.path.startsWith("typst")) {
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

        build.onLoad(
            {filter: /.*/, namespace: "wasm-binary"},
            async args => {
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
            },
        );
    },
};

const options = {
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
        ".html": "copy",
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
};

if (mode === "watch") {
    options.inject = [path.join(__dirname, "./livereload.js")];
}

if (mode === "watch") {
    const ctx = await esbuild.context(options);

    // Watch for changes and rebuild on change
    await ctx.watch();
    await ctx.serve({
        servedir: path.join(__dirname, "../../public"),
        cors: {
            origin: "*",
        },
    });
} else {
    const [coreResult, tinymistResult] = await Promise.all([
        esbuild.build({
            ...options,
            entryPoints,
            outdir,
        }),
        esbuild.build({
            ...options,
            entryPoints: tinymistEntryPoints,
            outdir: tinymistOutDir,
        }),
    ]);

    const allOutputs = {
        ...coreResult.metafile.outputs,
        ...tinymistResult.metafile.outputs,
    };

    for (const file of Object.keys(allOutputs)) {
        const output = allOutputs[file];
        console.log(`Written: ${file} @ ${Math.round(output.bytes / 1000)}kB`);
    }

    fs.writeFileSync(
        "esbuild-meta.json",
        JSON.stringify({
            core: coreResult.metafile,
            tinymist: tinymistResult.metafile,
        }),
    );
}
