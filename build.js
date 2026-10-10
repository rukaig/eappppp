const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;
const publishDirectory = path.join(projectRoot, "dist");
const publishableExtensions = new Set([
  ".html",
  ".css",
  ".svg",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".webmanifest"
]);

fs.rmSync(publishDirectory, { recursive: true, force: true });
fs.mkdirSync(publishDirectory, { recursive: true });

for (const fileName of fs.readdirSync(projectRoot)) {
  const sourcePath = path.join(projectRoot, fileName);
  if (!fs.statSync(sourcePath).isFile()) continue;
  if (fileName !== "_redirects" && !publishableExtensions.has(path.extname(fileName).toLowerCase())) continue;
  fs.copyFileSync(sourcePath, path.join(publishDirectory, fileName));
}

fs.cpSync(
  path.join(projectRoot, "assets"),
  path.join(publishDirectory, "assets"),
  { recursive: true }
);

fs.copyFileSync(
  path.join(projectRoot, "appli.html"),
  path.join(publishDirectory, "index.html")
);

console.log(`Static prototype ready in ${path.relative(projectRoot, publishDirectory)}.`);
