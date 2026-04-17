"use client";

import { presignImage } from "@/lib/api";

/**
 * Upload `file` using a presigned URL. Returns the public URL to embed in
 * the image block.
 */
export async function uploadImage(file: File): Promise<{
  publicUrl: string;
  imageId: string;
}> {
  const { uploadUrl, publicUrl, imageId } = await presignImage(
    file.type || "application/octet-stream",
    file.size,
  );
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!resp.ok) {
    throw new Error(`Image upload failed: ${resp.status}`);
  }
  return { publicUrl, imageId };
}
