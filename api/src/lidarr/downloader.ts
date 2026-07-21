import { Request, Response } from "express";

import { getAppInstance } from "../helpers/app-instance";
import { removeItemFromHistory } from "../services/history";
import { ProcessingItemType } from "../types";

import {
  createErrorResponse,
  createNzoId,
  createSuccessResponse,
  extractAlbumIdFromNzb,
  extractItemIdFromNzoId,
  extractQualityFromNzb,
  getQueueStatus,
  mapItemToHistorySlot,
  mapItemToQueueSlot,
  parseMultipartNzb,
} from "./utils/nzb";
import { addAlbumToQueue } from "./utils/tidal-search-albums";

/**
 * SABnzbd-compatible API for Lidarr download client integration
 * Minimal implementation supporting: version, addurl, queue, history
 */

/**
 * GET /api/sabnzbd?mode=addurl&name=<url>&nzbname=<name>&cat=<category>&priority=<priority>
 * POST /api/sabnzbd?mode=addfile (multipart/form-data with NZB file)
 * Adds an album to the download queue
 */
export async function handleAddUrlRequest(req: Request, res: Response) {
  try {
    const { mode } = req.query;

    // mode=addfile - Lidarr uploads NZB file
    if (mode === "addfile") {
      console.log("[SABnzbd] Processing addfile request (NZB upload)");

      // Extract boundary from Content-Type header
      const contentType = req.headers["content-type"];
      if (!contentType || !contentType.includes("multipart/form-data")) {
        console.log("[SABnzbd] Invalid content type for addfile");
        return res.json(
          createErrorResponse("multipart/form-data required for addfile"),
        );
      }

      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        console.log("[SABnzbd] No boundary found in content-type");
        return res.json(createErrorResponse("No boundary in multipart data"));
      }

      const boundary = boundaryMatch[1].replace(/^-+/, ""); // Remove leading dashes

      // Get raw body content - express.raw() provides it as a Buffer in req.body
      const rawBody = req.body;
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        console.log("[SABnzbd] No body data received or invalid format");
        return res.json(createErrorResponse("No file data received"));
      }

      // Convert Buffer to string for parsing
      const bodyString = rawBody.toString("utf8");

      // Parse NZB content from multipart data
      const nzbContent = parseMultipartNzb(bodyString, boundary);

      if (!nzbContent) {
        console.log("[SABnzbd] Failed to extract NZB content from upload");
        return res.json(createErrorResponse("Failed to parse NZB file"));
      }

      const albumId = extractAlbumIdFromNzb(nzbContent);
      const quality = extractQualityFromNzb(nzbContent);

      if (!albumId) {
        console.log("[SABnzbd] Invalid NZB - album ID not found");
        return res.json(
          createErrorResponse("Invalid NZB format - album ID not found"),
        );
      }

      console.log(
        `[SABnzbd] Album ${albumId}${quality ? ` (${quality})` : ""}`,
      );

      await addAlbumToQueue(albumId, quality);

      return res.json(createSuccessResponse([createNzoId(albumId, "lidarr")]));
    }

    // Fallback
    console.log(`[SABnzbd] Unknown addurl/addfile request`);
    return res.json(createSuccessResponse(["lidarr_nzo_unknown"]));
  } catch (error) {
    console.error("[SABnzbd] Error in addurl/addfile:", error);
    return res.json(createErrorResponse(String(error)));
  }
}

/**
 * Shared delete handler for both queue and history
 * GET /api/sabnzbd?mode=queue&name=delete&value=<nzo_id>
 * GET /api/sabnzbd?mode=history&name=delete&value=<nzo_id>
 * Removes an item from the processing stack
 */
async function handleDeleteRequest(
  req: Request,
  res: Response,
  source: "queue" | "history",
): Promise<Response> {
  try {
    const { value } = req.query;

    if (!value || typeof value !== "string") {
      console.log(`[SABnzbd] Delete request missing nzo_id (${source})`);
      return res.json(createErrorResponse("Missing nzo_id parameter"));
    }

    const nzoId = value as string;
    const parsedNzoId = extractItemIdFromNzoId(nzoId);

    if (!parsedNzoId) {
      console.log(`[SABnzbd] Invalid nzo_id (${source}): ${nzoId}`);
      return res.json(createErrorResponse("Invalid nzo_id parameter"));
    }

    const { itemId } = parsedNzoId;

    console.log(
      `[SABnzbd] Delete request for nzo_id: ${nzoId} (item ID: ${itemId}) from ${source}`,
    );

    const app = getAppInstance();
    const processingStack = app.locals.processingStack;

    if (!processingStack) {
      return res.json(createErrorResponse("Processing stack not available"));
    }

    const item =
      processingStack.actions.getItem(itemId) ??
      processingStack.data.find(
        (processingItem: ProcessingItemType) =>
          String(processingItem.id) === itemId,
      );

    if (source === "history") {
      await removeItemFromHistory(itemId);

      if (item) {
        await processingStack.actions.removeItem(item.id);
      }

      const itemStillExists = processingStack.data.some(
        (processingItem: ProcessingItemType) =>
          String(processingItem.id) === itemId,
      );
      if (itemStillExists) {
        throw new Error(`Failed to remove processing item ${itemId}`);
      }

      console.log(`[SABnzbd] Successfully acknowledged history item ${itemId}`);
      return res.json(createSuccessResponse([nzoId]));
    }

    if (!item) {
      console.log(`[SABnzbd] Item ${itemId} not found in ${source}`);
      return res.json(createErrorResponse("Item not found"));
    }

    // Remove the item from the processing stack
    await processingStack.actions.removeItem(item.id);

    console.log(`[SABnzbd] Successfully removed item ${itemId} from ${source}`);

    return res.json(createSuccessResponse([nzoId]));
  } catch (error) {
    console.error(`[SABnzbd] Error in ${source} delete:`, error);
    return res.json(createErrorResponse(String(error)));
  }
}

/**
 * GET /api/sabnzbd?mode=queue
 * Returns current download queue status
 * Maps Tidarr processing queue to SABnzbd queue format
 */
export function handleQueueRequest(req: Request, res: Response) {
  const { name } = req.query;

  // Handle queue delete operations
  if (name === "delete") {
    return handleDeleteRequest(req, res, "queue");
  }

  try {
    const app = getAppInstance();
    const processingStack = app.locals.processingStack;

    if (!processingStack) {
      return res.json({
        queue: {
          status: "Idle",
          paused: false,
          slots: [],
        },
      });
    }

    const { data } = processingStack;
    const { isPaused } = processingStack.actions.getQueueStatus();

    // Map Tidarr items to SABnzbd queue slots
    const slots = data
      .filter(
        (item: ProcessingItemType) =>
          [
            "queue_download",
            "download",
            "queue_processing",
            "processing",
          ].includes(item.status) && item.source === "lidarr",
      )
      .map((item: ProcessingItemType) => mapItemToQueueSlot(item, isPaused));

    return res.json({
      queue: {
        status: getQueueStatus(isPaused, slots.length),
        paused: isPaused,
        pause_int: "0",
        speedlimit: "",
        speedlimit_abs: "",
        noofslots: slots.length,
        limit: 0,
        start: 0,
        finish: 0,
        slots,
      },
    });
  } catch (error) {
    console.error("[SABnzbd] Error in queue request:", error);
    return res.json({
      queue: {
        status: "Idle",
        paused: false,
        slots: [],
      },
    });
  }
}

/**
 * GET /api/sabnzbd?mode=history&limit=<n>
 * Returns download history
 * Maps Tidarr finished/error items to SABnzbd history format
 */
export function handleHistoryRequest(req: Request, res: Response) {
  const { name } = req.query;

  // Handle history delete operations
  if (name === "delete") {
    return handleDeleteRequest(req, res, "history");
  }

  try {
    const app = getAppInstance();
    const processingStack = app.locals.processingStack;
    const { limit = "60" } = req.query;
    const limitNum = parseInt(limit as string, 10) || 60;

    if (!processingStack) {
      return res.json({
        history: {
          noofslots: 0,
          slots: [],
        },
      });
    }

    const { data } = processingStack;

    // Map all finished/error items to SABnzbd history slots. The source and
    // source-relative output paths let bridge clients resolve the correct
    // mounted download root.
    const slots = data
      .filter((item: ProcessingItemType) =>
        ["finished", "error"].includes(item.status),
      )
      .slice(0, limitNum)
      .map(mapItemToHistorySlot);

    return res.json({
      history: {
        noofslots: slots.length,
        month_size: "0 B",
        week_size: "0 B",
        day_size: "0 B",
        total_size: "0 B",
        slots,
      },
    });
  } catch (error) {
    console.error("[SABnzbd] Error in history request:", error);
    return res.json({
      history: {
        noofslots: 0,
        slots: [],
      },
    });
  }
}
