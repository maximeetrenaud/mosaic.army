const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function convertDir(dirName) {
    const dir = path.join(__dirname, dirName);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (file.endsWith('.png')) {
            const inPath = path.join(dir, file);
            const outPath = path.join(dir, file.replace('.png', '.webp'));
            await sharp(inPath).webp({ quality: 80 }).toFile(outPath);
            fs.unlinkSync(inPath);
            console.log(`Converted: ${inPath} -> ${outPath}`);
        }
    }
}

async function run() {
    await convertDir('uploads');
    await convertDir('templates');
    console.log('Conversion complete!');
}

run();
