import { rm } from "node:fs/promises";
import { build } from "esbuild";
import pkg from "../package.json" with { type: "json" };

const banner = `/*! ${pkg.name} v${pkg.version} */`;

await rm("dist", { recursive: true, force: true });

const shared = {
    entryPoints: ["src/index.ts"],
    bundle: true,
    sourcemap: true,
    target: "es2020",
    banner: { js: banner },
    define: {
        __SDK_VERSION__: JSON.stringify(pkg.version)
    }
};

await Promise.all([
    build({
        ...shared,
        format: "esm",
        outfile: "dist/index.mjs"
    }),
    build({
        ...shared,
        format: "cjs",
        outfile: "dist/index.cjs"
    }),
    build({
        ...shared,
        format: "iife",
        globalName: "LoopAdAdvertisementSDK",
        outfile: "dist/loop-ad-advertisement-sdk.iife.js"
    })
]);
