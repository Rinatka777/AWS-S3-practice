import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getVideo, updateVideo } from "../db/videos";
import { getBearerToken, validateJWT } from "../auth";
import { randomBytes } from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const uploadedVideo = formData.get("video");

  if (!uploadedVideo || !(uploadedVideo instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (uploadedVideo.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type, only MP4 is supported");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (uploadedVideo.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File too large");
  }

  const tmpPath = "tmp/video.mp4";
  await Bun.write(tmpPath, uploadedVideo);

  const aspectRatio = await getVideoAspectRatio(tmpPath);
  const key = `${aspectRatio}/${randomBytes(32).toString("hex")}.mp4`;
  try {
    await cfg.s3Client.file(key, { bucket: cfg.s3Bucket, type: "video/mp4" }).write(Bun.file(tmpPath));
  } finally {
    await Bun.file(tmpPath).unlink();
  }

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${stderrText}`);
  }

  const { streams } = JSON.parse(stdoutText);
  const { width, height } = streams[0];

  const ratio = Math.floor(width / height * 100);
  if (ratio === Math.floor(16 / 9 * 100)) return "landscape";
  if (ratio === Math.floor(9 / 16 * 100)) return "portrait";
  return "other";
}