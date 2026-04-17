"use client";

import { useRef, useState } from "react";
import { uploadImage } from "@/editor/image-upload";
import { useBlockStore } from "@/store/block-store";
import type { Block } from "@/lib/types";

interface Props {
  block: Block;
}

export function ImageBlock({ block }: Props) {
  const updateAttrs = useBlockStore((s) => s.updateAttrs);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const attrs = block.content.attrs as
    | { src?: string; alt?: string; imageId?: string }
    | undefined;
  const src = attrs?.src;

  async function onPick(file: File): Promise<void> {
    setStatus("uploading");
    setError(null);
    try {
      const { publicUrl, imageId } = await uploadImage(file);
      updateAttrs(block.blockId, { src: publicUrl, imageId });
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "upload failed");
    }
  }

  return (
    <div className="block image-block">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={attrs?.alt ?? ""} className="image-preview" />
      ) : (
        <div className="image-picker">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
          />
          <button
            type="button"
            className="image-pick-button"
            onClick={() => inputRef.current?.click()}
            disabled={status === "uploading"}
          >
            {status === "uploading" ? "Uploading…" : "Click to upload image"}
          </button>
          {error ? <span className="image-error">{error}</span> : null}
        </div>
      )}
    </div>
  );
}
