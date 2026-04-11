import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";

/**
 * Download an image from a URL and save it locally
 * @param url - Image URL to download
 * @param workspaceDir - Directory to save the image (default: ~/.openclaw/workspace/media)
 * @returns Local file path if successful, undefined if failed
 */
export async function downloadImageFromUrl(
  url: string,
  workspaceDir?: string,
): Promise<string | undefined> {
  try {
    const targetDir = workspaceDir || path.join(os.homedir(), ".openclaw/media/inbound");

    // Ensure directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Generate filename from URL hash + timestamp (local time, not UTC)
    const urlHash = crypto.createHash("md5").update(url).digest("hex").substring(0, 8);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const ext = getExtensionFromUrl(url) || "jpg";
    const filename = `${timestamp}-zalo-${urlHash}.${ext}`;
    const filePath = path.join(targetDir, filename);

    // Download the image
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[image-downloader] Failed to fetch ${url}: ${response.status}`);
      return undefined;
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));

    console.log(`[image-downloader] Downloaded: ${url} -> ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[image-downloader] Error downloading ${url}:`, err);
    return undefined;
  }
}

/**
 * Download multiple images from URLs
 * @param urls - Array of image URLs
 * @param workspaceDir - Directory to save images
 * @returns Array of local file paths (undefined for failed downloads)
 */
export async function downloadImagesFromUrls(
  urls: string[],
  workspaceDir?: string,
): Promise<(string | undefined)[]> {
  const downloads = urls.map(url => downloadImageFromUrl(url, workspaceDir));
  return Promise.all(downloads);
}

/**
 * Extract file extension from URL
 */
function getExtensionFromUrl(url: string): string | undefined {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
