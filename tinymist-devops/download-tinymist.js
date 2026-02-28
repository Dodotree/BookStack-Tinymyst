/* eslint-disable */
/**
 * Tinymist Installation Script
 *
 * This script automatically downloads and installs the Tinymist LSP binary
 * from GitHub releases. It detects the platform and architecture automatically.
 *
 * Tinymist is a Language Server Protocol implementation for Typst, providing
 * features like autocomplete, diagnostics, and incremental compilation.
 *
 * Usage: node dev/build/download-tinymist.js
 *
 * The script will:
 * 1. Detect the current platform (Windows/Linux/macOS) and architecture (x64/ARM64)
 * 2. Download the appropriate Tinymist binary from GitHub releases
 * 3. Extract the binary to vendor/bin/tinymist[.exe]
 * 4. Verify the installation by running tinymist --version
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Configuration
const TINYMIST_VERSION = '0.14.10';
const TINYMIST_RELEASE_REPO = process.env.TINYMIST_RELEASE_REPO || 'Dodotree/tinymist';
const TINYMIST_RELEASE_TAG = process.env.TINYMIST_RELEASE_TAG || '0.14.10';
const VENDOR_BIN_DIR = path.join(__dirname, '..', 'vendor', 'bin');

/**
 * Detect platform and architecture
 */
function detectPlatform() {
    const platform = os.platform();
    const arch = os.arch();

    console.log(`\n📦 Tinymist Installation Script`);
    console.log(`Platform: ${platform}-${arch}`);
    console.log(`Version: ${TINYMIST_VERSION}`);
    console.log(`Release: ${TINYMIST_RELEASE_REPO}@${TINYMIST_RELEASE_TAG}`);

    let packageName;
    let extractionMethod;

    // Patched fork ships direct binary assets per platform.
    if (TINYMIST_RELEASE_REPO === 'Dodotree/tinymist') {
        packageName = platform === 'win32' ? 'tinymist.exe' : 'tinymist';
        extractionMethod = 'binary';
        console.log(`Package: ${packageName}\n`);
        return { packageName, extractionMethod, platform };
    }

    if (platform === 'win32') {
        if (arch === 'x64') {
            packageName = 'tinymist-x86_64-pc-windows-msvc.zip';
            extractionMethod = 'zip';
        } else if (arch === 'arm64') {
            packageName = 'tinymist-aarch64-pc-windows-msvc.zip';
            extractionMethod = 'zip';
        } else {
            throw new Error(`Unsupported Windows architecture: ${arch}`);
        }
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            packageName = 'tinymist-x86_64-unknown-linux-gnu.tar.gz';
            extractionMethod = 'tar';
        } else if (arch === 'arm64') {
            packageName = 'tinymist-aarch64-unknown-linux-gnu.tar.gz';
            extractionMethod = 'tar';
        } else {
            throw new Error(`Unsupported Linux architecture: ${arch}`);
        }
    } else if (platform === 'darwin') {
        if (arch === 'x64') {
            packageName = 'tinymist-x86_64-apple-darwin.tar.gz';
            extractionMethod = 'tar';
        } else if (arch === 'arm64') {
            packageName = 'tinymist-aarch64-apple-darwin.tar.gz';
            extractionMethod = 'tar';
        } else {
            throw new Error(`Unsupported macOS architecture: ${arch}`);
        }
    } else {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    console.log(`Package: ${packageName}\n`);

    return { packageName, extractionMethod, platform };
}

/**
 * Download file from URL with progress indication
 */
function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading from GitHub...`);

        const file = fs.createWriteStream(destination);
        let downloadedBytes = 0;
        let totalBytes = 0;

        https.get(url, { headers: { 'User-Agent': 'BookStack-Tinymist-Installer' } }, (response) => {
            // Handle redirects
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlinkSync(destination);
                return downloadFile(response.headers.location, destination)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destination);
                return reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
            }

            totalBytes = parseInt(response.headers['content-length'], 10);

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
                process.stdout.write(`\rProgress: ${progress}% (${downloadedMB}/${totalMB} MB)`);
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log('\n✅ Download complete\n');
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(destination);
            reject(err);
        });
    });
}

/**
 * Extract archive based on platform
 */
function extractArchive(archivePath, extractionMethod, platform) {
    console.log(`📦 Extracting archive...`);

    const tempExtractDir = path.join(VENDOR_BIN_DIR, 'temp_tinymist');

    // Create temp directory
    if (!fs.existsSync(tempExtractDir)) {
        fs.mkdirSync(tempExtractDir, { recursive: true });
    }

    try {
        if (extractionMethod === 'zip') {
            // Use PowerShell on Windows for ZIP extraction
            const psCommand = `Expand-Archive -Path "${archivePath}" -DestinationPath "${tempExtractDir}" -Force`;
            execSync(`powershell -Command "${psCommand}"`, { stdio: 'inherit' });
        } else if (extractionMethod === 'tar') {
            // Use tar for .tar.gz extraction
            execSync(`tar -xzf "${archivePath}" -C "${tempExtractDir}"`, { stdio: 'inherit' });
        }

        // Find the tinymist binary in extracted files
        const binaryName = platform === 'win32' ? 'tinymist.exe' : 'tinymist';
        const extractedBinary = findBinaryInDirectory(tempExtractDir, binaryName);

        if (!extractedBinary) {
            throw new Error(`Could not find ${binaryName} in extracted archive`);
        }

        // Move binary to vendor/bin
        const targetBinary = path.join(VENDOR_BIN_DIR, binaryName);
        fs.copyFileSync(extractedBinary, targetBinary);

        // Make executable on Unix systems
        if (platform !== 'win32') {
            fs.chmodSync(targetBinary, 0o755);
        }

        console.log(`✅ Extracted to: ${targetBinary}\n`);

        // Cleanup
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
        fs.unlinkSync(archivePath);

        return targetBinary;

    } catch (error) {
        // Cleanup on error
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * Recursively find binary in directory
 */
function findBinaryInDirectory(dir, binaryName) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            const found = findBinaryInDirectory(fullPath, binaryName);
            if (found) return found;
        } else if (file === binaryName) {
            return fullPath;
        }
    }

    return null;
}

/**
 * Verify installation
 */
function verifyInstallation(binaryPath) {
    console.log(`🔍 Verifying installation...`);

    try {
        const version = execSync(`"${binaryPath}" --version`, { encoding: 'utf8' });
        console.log(`✅ Tinymist installed successfully!`);
        console.log(`Location: ${binaryPath}`);
        console.log(`Version: ${version.trim()}\n`);
        return true;
    } catch (error) {
        console.error(`❌ Installation verification failed`);
        console.error(error.message);
        return false;
    }
}

/**
 * Main installation function
 */
async function installTinymist() {
    try {
        const { packageName, extractionMethod, platform } = detectPlatform();

        // Create vendor/bin directory if it doesn't exist
        if (!fs.existsSync(VENDOR_BIN_DIR)) {
            fs.mkdirSync(VENDOR_BIN_DIR, { recursive: true });
        }

        // Check if already installed
        const binaryName = platform === 'win32' ? 'tinymist.exe' : 'tinymist';
        const binaryPath = path.join(VENDOR_BIN_DIR, binaryName);

        if (fs.existsSync(binaryPath)) {
            console.log(`ℹ️  Tinymist already exists at ${binaryPath}`);
            if (verifyInstallation(binaryPath)) {
                console.log(`✅ Using existing installation\n`);
                return;
            } else {
                console.log(`⚠️  Existing installation invalid, reinstalling...\n`);
                fs.unlinkSync(binaryPath);
            }
        }

        const downloadUrl = `https://github.com/${TINYMIST_RELEASE_REPO}/releases/download/${TINYMIST_RELEASE_TAG}/${packageName}`;
        const archivePath = path.join(VENDOR_BIN_DIR, packageName);

        // Download
        await downloadFile(downloadUrl, archivePath);

        // Extract or install direct binary
        let installedBinary;
        if (extractionMethod === 'binary') {
            installedBinary = archivePath;
            if (platform !== 'win32') {
                fs.chmodSync(installedBinary, 0o755);
            }
        } else {
            installedBinary = extractArchive(archivePath, extractionMethod, platform);
        }

        // Verify
        verifyInstallation(installedBinary);

        console.log(`\n🎉 Tinymist installation complete!`);
        console.log(`\nYou can now use Tinymist in BookStack's editor.\n`);

    } catch (error) {
        console.error(`\n❌ Installation failed:`);
        console.error(error.message);
        console.error(`\nPlease install Tinymist manually:`);
        console.error(`1. Download from: https://github.com/${TINYMIST_RELEASE_REPO}/releases/tag/${TINYMIST_RELEASE_TAG}`);
        console.error(`2. Extract the binary to: ${VENDOR_BIN_DIR}`);
        console.error(`3. Ensure it's executable\n`);

        console.warn('⚠️  Continuing without Tinymist binary (non-fatal for install/test workflows).\n');
        process.exit(0);
    }
}

// Run installation
if (require.main === module) {
    installTinymist();
}

module.exports = { installTinymist };
