#!/usr/bin/env node
/* eslint-disable */
/**
 * Download Typst CLI binary for the current platform.
 * This runs automatically after npm install.
 *
 * Downloads pre-built Typst binaries from GitHub releases and places them
 * in vendor/bin/ directory for use by BookStack's Tinymist editor.
 *
 * Note: This is a Node.js script file, not browser JavaScript.
 * ESLint is disabled for this file as it uses Node.js APIs.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const VERSION = '0.14.2';
const VENDOR_BIN_DIR = path.join(__dirname, '..', 'vendor', 'bin');

// Determine platform
const platform = os.platform();
const arch = os.arch();

console.log(`\n📦 Typst Installation Script`);
console.log(`   Platform: ${platform}-${arch}`);

const platformMap = {
    'win32-x64': 'typst-x86_64-pc-windows-msvc.zip',
    'win32-arm64': 'typst-aarch64-pc-windows-msvc.zip',
    'linux-x64': 'typst-x86_64-unknown-linux-musl.tar.xz',
    'linux-arm64': 'typst-aarch64-unknown-linux-musl.tar.xz',
    'darwin-x64': 'typst-x86_64-apple-darwin.tar.xz',
    'darwin-arm64': 'typst-aarch64-apple-darwin.tar.xz',
};

const platformKey = `${platform}-${arch}`;
const filename = platformMap[platformKey];

if (!filename) {
    console.error(`\n❌ Unsupported platform: ${platformKey}`);
    console.log('   Supported platforms:');
    Object.keys(platformMap).forEach(key => console.log(`   - ${key}`));
    console.log('\n   Please install Typst manually from:');
    console.log('   https://github.com/typst/typst/releases\n');
    process.exit(0); // Don't fail the build
}

const downloadUrl = `https://github.com/typst/typst/releases/download/v${VERSION}/${filename}`;
const tempFile = path.join(os.tmpdir(), filename);

console.log(`   Version: ${VERSION}`);
console.log(`   Package: ${filename}`);

// Check if already installed
const expectedBinary = path.join(VENDOR_BIN_DIR, platform === 'win32' ? 'typst.exe' : 'typst');
if (fs.existsSync(expectedBinary)) {
    try {
        const version = execSync(`"${expectedBinary}" --version`, { encoding: 'utf8' }).trim();
        console.log(`\n✅ Typst already installed: ${version}`);
        console.log(`   Location: ${expectedBinary}\n`);
        process.exit(0);
    } catch (err) {
        console.log(`\n⚠️  Existing binary found but not working, reinstalling...`);
    }
}

// Create vendor/bin directory if it doesn't exist
if (!fs.existsSync(VENDOR_BIN_DIR)) {
    fs.mkdirSync(VENDOR_BIN_DIR, { recursive: true });
    console.log(`   Created: ${VENDOR_BIN_DIR}`);
}

console.log(`\n📥 Downloading from GitHub...`);
console.log(`   ${downloadUrl}`);

// Download file with progress
downloadFile(downloadUrl, tempFile, (err) => {
    if (err) {
        console.error(`\n❌ Download failed: ${err.message}`);
        console.log('   Please install Typst manually from:');
        console.log('   https://github.com/typst/typst/releases\n');
        fs.unlink(tempFile, () => {});
        process.exit(0); // Don't fail the build
        return;
    }

    console.log('\n✅ Download complete');
    extractAndInstall(tempFile);
});

/**
 * Download file with redirect following and progress indication.
 */
function downloadFile(url, dest, callback, redirectCount = 0) {
    if (redirectCount > 5) {
        callback(new Error('Too many redirects'));
        return;
    }

    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
            file.close();
            fs.unlink(dest, () => {});
            downloadFile(response.headers.location, dest, callback, redirectCount + 1);
            return;
        }

        if (response.statusCode !== 200) {
            callback(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
            downloaded += chunk.length;
            if (totalSize) {
                const percent = ((downloaded / totalSize) * 100).toFixed(1);
                const mb = (downloaded / 1024 / 1024).toFixed(1);
                const totalMb = (totalSize / 1024 / 1024).toFixed(1);
                process.stdout.write(`\r   Progress: ${percent}% (${mb}/${totalMb} MB)`);
            }
        });

        response.pipe(file);

        file.on('finish', () => {
            file.close(() => {
                if (totalSize) process.stdout.write('\n');
                callback(null);
            });
        });

    }).on('error', (err) => {
        fs.unlink(dest, () => {});
        callback(err);
    });
}

/**
 * Extract archive and install binary.
 */
function extractAndInstall(archivePath) {
    console.log('\n📂 Extracting archive...');

    try {
        if (platform === 'win32') {
            extractZip(archivePath);
        } else {
            extractTarXz(archivePath);
        }
    } catch (err) {
        console.error(`\n❌ Extraction failed: ${err.message}`);
        console.log('   Please install Typst manually from:');
        console.log('   https://github.com/typst/typst/releases\n');
        process.exit(0); // Don't fail the build
    }
}

/**
 * Extract ZIP on Windows.
 */
function extractZip(archivePath) {
    // Use PowerShell to extract
    const extractDir = path.join(VENDOR_BIN_DIR, 'typst-temp');

    if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
    }

    const psCommand = `Expand-Archive -Force "${archivePath.replace(/\\/g, '\\\\')}" "${extractDir.replace(/\\/g, '\\\\')}"`;
    execSync(`powershell -command "${psCommand}"`, { stdio: 'inherit' });

    // Find and move the typst.exe binary
    const files = fs.readdirSync(extractDir, { recursive: true });
    const typstExe = files.find(f => f.endsWith('typst.exe'));

    if (typstExe) {
        const sourcePath = path.join(extractDir, typstExe);
        const targetPath = path.join(VENDOR_BIN_DIR, 'typst.exe');
        fs.copyFileSync(sourcePath, targetPath);

        // Cleanup
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.unlinkSync(archivePath);

        console.log('✅ Typst installed successfully!');
        console.log(`   Location: ${targetPath}`);

        // Test installation
        testInstallation(targetPath);
    } else {
        throw new Error('Could not find typst.exe in archive');
    }
}

/**
 * Extract tar.xz on Unix-like systems.
 */
function extractTarXz(archivePath) {
    // Extract to temporary directory
    const extractDir = path.join(VENDOR_BIN_DIR, 'typst-temp');

    if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(extractDir);

    execSync(`tar -xJf "${archivePath}" -C "${extractDir}"`, { stdio: 'inherit' });

    // Find the typst binary
    const findTypst = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const result = findTypst(fullPath);
                if (result) return result;
            } else if (entry.name === 'typst') {
                return fullPath;
            }
        }
        return null;
    };

    const typstBin = findTypst(extractDir);

    if (typstBin) {
        const targetPath = path.join(VENDOR_BIN_DIR, 'typst');
        fs.copyFileSync(typstBin, targetPath);
        fs.chmodSync(targetPath, 0o755);

        // Cleanup
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.unlinkSync(archivePath);

        console.log('✅ Typst installed successfully!');
        console.log(`   Location: ${targetPath}`);

        // Test installation
        testInstallation(targetPath);
    } else {
        throw new Error('Could not find typst binary in archive');
    }
}

/**
 * Test the installed Typst binary.
 */
function testInstallation(binaryPath) {
    try {
        const version = execSync(`"${binaryPath}" --version`, { encoding: 'utf8' }).trim();
        console.log(`   Version: ${version}`);
        console.log('');
    } catch (err) {
        console.warn('\n⚠️  Could not verify Typst installation');
        console.log(`   Error: ${err.message}\n`);
    }
}
