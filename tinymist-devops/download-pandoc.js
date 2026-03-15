#!/usr/bin/env node
/* eslint-disable */
/**
 * Download Pandoc binary for the current platform.
 *
 * This script follows the same approach used for Typst/Tinymist installers:
 * - Download a release asset from GitHub
 * - Extract and place binary into vendor/bin
 * - Verify installation with --version
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PANDOC_RELEASE_REPO = process.env.PANDOC_RELEASE_REPO || 'jgm/pandoc';
const PANDOC_RELEASE_TAG = (process.env.PANDOC_RELEASE_TAG || 'latest').trim();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const VENDOR_BIN_DIR = path.join(__dirname, '..', 'vendor', 'bin');
const platform = os.platform();
const arch = os.arch();

function logHeader() {
    console.log('\n📦 Pandoc Installation Script');
    console.log(`Platform: ${platform}-${arch}`);
    console.log(`Release: ${PANDOC_RELEASE_REPO}@${PANDOC_RELEASE_TAG}`);
}

function getReleaseApiUrl() {
    if (PANDOC_RELEASE_TAG.toLowerCase() === 'latest') {
        return `https://api.github.com/repos/${PANDOC_RELEASE_REPO}/releases/latest`;
    }

    const normalizedTag = PANDOC_RELEASE_TAG.startsWith('v')
        ? PANDOC_RELEASE_TAG
        : `v${PANDOC_RELEASE_TAG}`;

    return `https://api.github.com/repos/${PANDOC_RELEASE_REPO}/releases/tags/${normalizedTag}`;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'BookStack-Pandoc-Installer',
            'Accept': 'application/vnd.github+json',
        };

        if (GITHUB_TOKEN) {
            headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
        }

        https.get(url, { headers }, (response) => {
            let body = '';
            response.on('data', (chunk) => {
                body += chunk.toString('utf8');
            });

            response.on('end', () => {
                if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(new Error(`Failed to parse GitHub response: ${error.message}`));
                    }
                    return;
                }

                reject(new Error(`Failed release lookup: HTTP ${response.statusCode} ${response.statusMessage || ''}`.trim()));
            });
        }).on('error', reject);
    });
}

function selectAsset(assets) {
    const files = Array.isArray(assets) ? assets : [];

    const patternsByTarget = {
        'win32-x64': [/windows.*(x86_64|amd64).*\.zip$/i],
        'win32-arm64': [/windows.*arm64.*\.zip$/i],
        'linux-x64': [/linux.*(x86_64|amd64).*\.tar\.gz$/i],
        'linux-arm64': [/linux.*arm64.*\.tar\.gz$/i],
        'darwin-x64': [/(x86_64|amd64).*macos.*\.zip$/i, /macos.*(x86_64|amd64).*\.zip$/i],
        'darwin-arm64': [/arm64.*macos.*\.zip$/i, /macos.*arm64.*\.zip$/i],
    };

    const target = `${platform}-${arch}`;
    const patterns = patternsByTarget[target] || [];

    for (const pattern of patterns) {
        const match = files.find((asset) => {
            const name = String(asset?.name || '');
            return pattern.test(name) && !/sha256|checksum|signature|asc$/i.test(name);
        });

        if (match) {
            return match;
        }
    }

    return null;
}

function downloadFile(url, destination) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destination);
        let downloadedBytes = 0;
        let totalBytes = 0;

        const headers = { 'User-Agent': 'BookStack-Pandoc-Installer' };
        if (GITHUB_TOKEN) {
            headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
        }

        https.get(url, { headers }, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlinkSync(destination);
                return downloadFile(response.headers.location, destination).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destination);
                return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            }

            totalBytes = parseInt(response.headers['content-length'] || '0', 10);

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                    const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                    const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
                    process.stdout.write(`\rProgress: ${progress}% (${downloadedMB}/${totalMB} MB)`);
                }
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                if (totalBytes > 0) {
                    process.stdout.write('\n');
                }
                resolve();
            });
        }).on('error', (error) => {
            file.close();
            fs.unlink(destination, () => reject(error));
        });
    });
}

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

function installFromArchive(archivePath) {
    const extractionMethod = archivePath.toLowerCase().endsWith('.zip') ? 'zip' : 'tar';
    const tempExtractDir = path.join(VENDOR_BIN_DIR, 'temp_pandoc');

    if (!fs.existsSync(tempExtractDir)) {
        fs.mkdirSync(tempExtractDir, { recursive: true });
    }

    try {
        if (extractionMethod === 'zip') {
            if (platform === 'win32') {
                const psCommand = `Expand-Archive -Path "${archivePath}" -DestinationPath "${tempExtractDir}" -Force`;
                execSync(`powershell -Command "${psCommand}"`, { stdio: 'inherit' });
            } else {
                execSync(`unzip -o "${archivePath}" -d "${tempExtractDir}"`, { stdio: 'inherit' });
            }
        } else {
            execSync(`tar -xzf "${archivePath}" -C "${tempExtractDir}"`, { stdio: 'inherit' });
        }

        const binaryName = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
        const extractedBinary = findBinaryInDirectory(tempExtractDir, binaryName);
        if (!extractedBinary) {
            throw new Error(`Could not find ${binaryName} in extracted archive`);
        }

        const targetBinary = path.join(VENDOR_BIN_DIR, binaryName);
        fs.copyFileSync(extractedBinary, targetBinary);

        if (platform !== 'win32') {
            fs.chmodSync(targetBinary, 0o755);
        }

        fs.rmSync(tempExtractDir, { recursive: true, force: true });
        fs.unlinkSync(archivePath);

        return targetBinary;
    } catch (error) {
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        throw error;
    }
}

function verifyInstallation(binaryPath) {
    const version = execSync(`"${binaryPath}" --version`, { encoding: 'utf8' }).trim().split('\n')[0];
    console.log('✅ Pandoc installed successfully!');
    console.log(`Location: ${binaryPath}`);
    console.log(`Version: ${version}\n`);
}

async function installPandoc() {
    try {
        logHeader();

        if (!fs.existsSync(VENDOR_BIN_DIR)) {
            fs.mkdirSync(VENDOR_BIN_DIR, { recursive: true });
        }

        const binaryName = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
        const binaryPath = path.join(VENDOR_BIN_DIR, binaryName);
        if (fs.existsSync(binaryPath)) {
            try {
                verifyInstallation(binaryPath);
                console.log('✅ Using existing Pandoc installation\n');
                return;
            } catch {
                fs.unlinkSync(binaryPath);
            }
        }

        console.log('🔎 Looking up release metadata...');
        const release = await fetchJson(getReleaseApiUrl());
        const selectedAsset = selectAsset(release.assets || []);

        if (!selectedAsset || !selectedAsset.browser_download_url) {
            throw new Error(`No compatible Pandoc asset found for ${platform}-${arch}`);
        }

        console.log(`📦 Selected asset: ${selectedAsset.name}`);
        console.log('📥 Downloading from GitHub...');

        const archivePath = path.join(VENDOR_BIN_DIR, selectedAsset.name);
        await downloadFile(selectedAsset.browser_download_url, archivePath);

        const installedBinary = installFromArchive(archivePath);
        verifyInstallation(installedBinary);

        console.log('🎉 Pandoc installation complete!\n');
    } catch (error) {
        console.error('\n❌ Pandoc installation failed:');
        console.error(error.message || error);
        console.error(`\nPlease install Pandoc manually from https://github.com/${PANDOC_RELEASE_REPO}/releases`);
        console.warn('⚠️  Continuing without Pandoc binary (non-fatal for install/test workflows).\n');
        process.exit(0);
    }
}

if (require.main === module) {
    installPandoc();
}

module.exports = { installPandoc };
