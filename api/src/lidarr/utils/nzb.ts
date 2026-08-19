import { Request, Response } from "express";
import fs from "fs/promises";
import path from "path";

import { NZB_DOWNLOAD_PATH } from "../../../constants";
import { ProcessingItemType } from "../../types";

export type TidarrDownloadSource = "lidarr" | "tidarr";

/**
 * Extract album ID from NZB content
 * NZB format: <meta type="title">Tidarr Album {albumId}|{quality}</meta>
 */
export function extractAlbumIdFromNzb(nzbContent: string): string | null {
  const match = nzbContent.match(
    /<meta type="title">Tidarr Album (\d+)\|[\w_]+<\/meta>/,
  );
  return match ? match[1] : null;
}

/**
 * Extract quality from NZB content
 * NZB format: <meta type="title">Tidarr Album {albumId}|{quality}</meta>
 */
export function extractQualityFromNzb(nzbContent: string): string | null {
  const match = nzbContent.match(
    /<meta type="title">Tidarr Album \d+\|([\w_]+)<\/meta>/,
  );
  return match ? match[1] : null;
}

/**
 * Parse multipart/form-data to extract NZB file content
 * Simple implementation without external dependencies
 */
export function parseMultipartNzb(
  body: string,
  boundary: string,
): string | null {
  try {
    // Split by boundary
    const parts = body.split(`--${boundary}`);

    // Find the part containing the NZB file
    for (const part of parts) {
      // Check if this part contains a file upload (has Content-Disposition)
      if (
        part.includes("Content-Disposition") &&
        part.includes('name="name"')
      ) {
        // Extract content after headers (double CRLF)
        const contentMatch = part.split("\r\n\r\n");
        if (contentMatch.length >= 2) {
          // Return the NZB content (everything after headers, before next boundary)
          return contentMatch.slice(1).join("\r\n\r\n").trim();
        }
      }
    }

    return null;
  } catch (error) {
    console.error("[SABnzbd] Error parsing multipart data:", error);
    return null;
  }
}

// Constants
const SABNZBD_VERSION = "3.0.0";

// Helper functions
export function getTidarrDownloadSource(
  item: Pick<ProcessingItemType, "source">,
): TidarrDownloadSource {
  return item.source === "lidarr" ? "lidarr" : "tidarr";
}

export function createNzoId(
  itemId: string,
  source: TidarrDownloadSource,
): string {
  return `${source}_nzo_${itemId}`;
}

export function extractItemIdFromNzoId(
  nzoId: string,
): { itemId: string; source: TidarrDownloadSource } | null {
  const match = nzoId.match(/^(lidarr|tidarr)_nzo_(.+)$/);
  if (!match || !match[2]) return null;

  return {
    source: match[1] as TidarrDownloadSource,
    itemId: match[2],
  };
}

export function createErrorResponse(error: string) {
  return { status: false, error };
}

export function createSuccessResponse(nzoIds: string[]) {
  return { status: true, nzo_ids: nzoIds };
}

export function getQueueStatus(isPaused: boolean, slotsCount: number): string {
  if (isPaused) return "Paused";
  return slotsCount > 0 ? "Downloading" : "Idle";
}

export function mapItemToQueueSlot(
  item: ProcessingItemType,
  isPaused: boolean,
) {
  let status = "Queued";
  if (item.status === "download") {
    status = isPaused ? "Paused" : "Downloading";
  } else if (isPaused) {
    status = "Paused";
  }

  return {
    status,
    index: 0,
    eta: "unknown",
    timeleft: "0:00:00",
    avg_age: "0d",
    mb: "0.00",
    mbleft: "0.00",
    mbmissing: "0.00",
    size: "0 B",
    sizeleft: "0 B",
    filename: `${item.artist} - ${item.title}`,
    priority: "Normal",
    cat: "music",
    percentage: item.status === "download" ? "50" : "0",
    nzo_id: createNzoId(item.id, getTidarrDownloadSource(item)),
    unpackopts: "3",
    labels: [],
    path: `/downloads/${item.id}`,
    storage: `/downloads/${item.id}`,
  };
}

/**
 * Recursively sums file sizes under a directory.
 * Returns 0 if the directory doesn't exist or can't be read.
 */
export async function getFolderSizeBytes(folderPath: string): Promise<number> {
  let total = 0;

  let entries;
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      total += await getFolderSizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        const stats = await fs.stat(entryPath);
        total += stats.size;
      } catch {
        // File may have been removed between readdir and stat.
      }
    }
  }

  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);

  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

async function getCompletedItemBytes(
  item: ProcessingItemType,
  source: TidarrDownloadSource,
): Promise<number> {
  if (item.status !== "finished" || source !== "lidarr") {
    return 0;
  }

  return getFolderSizeBytes(path.join(NZB_DOWNLOAD_PATH, item.id));
}

export async function mapItemToHistorySlot(item: ProcessingItemType) {
  const isCompleted = item.status === "finished";
  const name = `${item.artist} - ${item.title}`;
  const source = getTidarrDownloadSource(item);
  const relativePaths = getTidarrRelativePaths(item);

  const downloadPath = `/downloads/${relativePaths[0] || item.id}`;
  const bytes = await getCompletedItemBytes(item, source);

  return {
    status: isCompleted ? "Completed" : "Failed",
    name,
    nzo_id: createNzoId(item.id, source),
    category: "music",
    size: formatBytes(bytes),
    bytes: String(bytes),
    fail_message: isCompleted ? "" : "Download failed",
    download_time: 0,
    downloaded: 0,
    completeness: 0,
    script: "None",
    script_log: "",
    script_line: "",
    download_name: name,
    path: downloadPath,
    storage: downloadPath,
    status_string: isCompleted ? "Completed" : "Failed",
    completed: isCompleted ? (item.completedAt ?? 0) : 0,
    tidarr_source: source,
    tidarr_relative_paths: relativePaths,
  };
}

export function getTidarrRelativePaths(item: ProcessingItemType): string[] {
  if (getTidarrDownloadSource(item) === "lidarr") {
    return [item.id];
  }

  const paths = item.outputPaths || [];
  const normalizedPaths = paths
    .map((outputPath) => outputPath.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((outputPath) => {
      if (!outputPath || outputPath === "." || outputPath.startsWith("/")) {
        return false;
      }

      return !outputPath.split("/").includes("..");
    });

  return [...new Set(normalizedPaths)];
}

/**
 * GET /api/sabnzbd?mode=version
 * Returns SABnzbd version for compatibility check
 */
export function handleVersionRequest(req: Request, res: Response) {
  res.json({
    version: SABNZBD_VERSION,
  });
}

/**
 * GET /api/sabnzbd?mode=get_config
 * Returns SABnzbd configuration
 * Required by Lidarr to validate the download client
 */
export function handleGetConfigRequest(req: Request, res: Response) {
  const musicDir = "/downloads";
  const processingDir = "/downloads";

  res.json({
    config: {
      version: SABNZBD_VERSION,
      categories: [
        {
          name: "music",
          priority: 0,
          pp: "3",
          script: "None",
          dir: musicDir,
        },
        {
          name: "*",
          priority: 0,
          pp: "3",
          script: "None",
          dir: musicDir,
        },
      ],
      misc: {
        complete_dir: musicDir,
        download_dir: processingDir,
        api_key: "",
      },
    },
  });
}
