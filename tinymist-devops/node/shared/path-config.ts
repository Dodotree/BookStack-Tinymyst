import { existsSync, statSync } from "fs";
import { isAbsolute, join, resolve } from "path";

export const PROJECT_ROOT = process.cwd();

function defaultExecutableName(command: "tinymist" | "typst"): string {
    return process.platform === "win32" ? `${command}.exe` : command;
}

function looksLikePath(value: string): boolean {
    return value.includes("/") || value.includes("\\") || value === "." || value.startsWith(".");
}

export function resolveProjectRelativePath(value: string | undefined, defaultRelative: string): string {
    const candidate = value?.trim() || defaultRelative;
    return isAbsolute(candidate) ? candidate : resolve(PROJECT_ROOT, candidate);
}

export function resolveExecutablePath(
    value: string | undefined,
    command: "tinymist" | "typst",
    defaultRelative?: string
): string {
    const candidate = value?.trim() || "";

    if (candidate === "") {
        return resolve(PROJECT_ROOT, defaultRelative ?? join("vendor", "bin", defaultExecutableName(command)));
    }

    if (!isAbsolute(candidate) && !looksLikePath(candidate)) {
        return candidate;
    }

    let resolvedPath = isAbsolute(candidate) ? candidate : resolve(PROJECT_ROOT, candidate);

    if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        resolvedPath = join(resolvedPath, defaultExecutableName(command));
    }

    return resolvedPath;
}

export function getTinymistCliPath(): string {
    return resolveExecutablePath(
        process.env.TINYMIST_CLI_PATH,
        "tinymist",
        join("vendor", "bin", defaultExecutableName("tinymist"))
    );
}

export function getTypstPackagePath(): string {
    return resolveProjectRelativePath(
        process.env.TYPST_PACKAGE_PATH,
        join("storage", "app", "tinymist", "packages")
    );
}
