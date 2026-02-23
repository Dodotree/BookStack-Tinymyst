#!/usr/bin/env node
/* eslint-disable no-console */

const path = require("path");
const { ChangeSet, Text } = require("@codemirror/state");

function getCodeMirrorStateVersion() {
    try {
        return require("@codemirror/state/package.json").version;
    } catch {
        return "unknown";
    }
}

function preview(value) {
    try {
        if (typeof value === "string") return value;
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function tryFromJSON(label, value) {
    try {
        const changeSet = ChangeSet.fromJSON(value);
        console.log(`✅ ${label}`);
        console.log(`   input: ${preview(value)}`);
        console.log(
            `   length=${changeSet.length}, newLength=${changeSet.newLength}, empty=${changeSet.empty}`,
        );
    } catch (error) {
        console.log(`❌ ${label}`);
        console.log(`   input: ${preview(value)}`);
        console.log(`   error: ${error && error.message ? error.message : error}`);
    }
}

function testRawString(raw) {
    console.log("\n---");
    console.log(`Raw input string: ${raw}`);

    tryFromJSON("A) direct fromJSON(raw string)", raw);

    let parsed;
    try {
        parsed = JSON.parse(raw);
        console.log(`ℹ️  JSON.parse(raw) -> ${typeof parsed}: ${preview(parsed)}`);
    } catch (error) {
        console.log(
            `ℹ️  JSON.parse(raw) failed: ${error && error.message ? error.message : error}`,
        );
        parsed = undefined;
    }

    if (parsed !== undefined) {
        tryFromJSON("B) fromJSON(JSON.parse(raw))", parsed);
    }

    const trimmed = raw.trim();
    if (/^-?\d+(\s*,\s*-?\d+)+$/.test(trimmed)) {
        const split = trimmed.split(",").map((part) => Number(part.trim()));
        tryFromJSON("C) fromJSON(raw split to number[])", split);
    }
}

function buildCanonicalExample() {
    const base = Text.of(["Hello world"]);
    const changes = [{ from: 6, to: 11, insert: "Linux" }];
    const changeSet = ChangeSet.of(changes, base.length);
    return {
        text: base.toString(),
        json: changeSet.toJSON(),
    };
}

function main() {
    console.log("=== CodeMirror ChangeSet JSON Decode Check ===");
    console.log(`node: ${process.version}`);
    console.log(`platform: ${process.platform}`);
    console.log(`cwd: ${process.cwd()}`);
    console.log(`script: ${path.relative(process.cwd(), __filename)}`);
    console.log(`@codemirror/state: ${getCodeMirrorStateVersion()}`);

    const canonical = buildCanonicalExample();
    console.log("\nCanonical generated sample (always valid):");
    console.log(`base text: ${canonical.text}`);
    console.log(`changeset json: ${JSON.stringify(canonical.json)}`);
    tryFromJSON("canonical toJSON payload", canonical.json);

    const defaultRawInputs = [
        "298,1,607",
        "[298,1,607]",
        '"[298,1,607]"',
        "[298,[1],607]",
        '[298,[1,"x"],607]',
        JSON.stringify(canonical.json),
    ];

    const argvInputs = process.argv.slice(2);
    const inputs = argvInputs.length > 0 ? argvInputs : defaultRawInputs;

    console.log("\nTesting raw input strings:");
    for (const raw of inputs) {
        testRawString(raw);
    }

    console.log("\nDone.");
}

main();
